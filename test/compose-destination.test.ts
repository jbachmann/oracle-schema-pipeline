import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComposeDestination,
  assertLocalEndpoint,
  project,
  service,
  volume,
  sqlSession,
  generatedReplay,
} from '../scripts/compose-destination.js';
import { CloneError, type Runner } from '../scripts/process.js';
test('only local socket Docker endpoints are accepted', () => {
  assertLocalEndpoint('unix:///tmp/docker.sock');
  for (const endpoint of [
    'ssh://host',
    'tcp://127.0.0.1:2375',
    'tcp://remote:2376',
    '',
  ])
    assert.throws(
      () => assertLocalEndpoint(endpoint),
      /CLONE_DESTINATION_MISMATCH/,
    );
});
test('SQL sessions use fixed failure status and disable substitution', () => {
  const sql = sqlSession('select 1 from dual;');
  assert.match(sql, /WHENEVER SQLERROR EXIT 1/);
  assert.doesNotMatch(sql, /SQL.SQLCODE/);
  assert.match(sql, /SET DEFINE OFF/);
  assert.match(sql, /CONTAINER=FREEPDB1/);
});
function runner(conflict = false, retainedVolume = false) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; input?: string }[] =
    [];
  const run: Runner = async (_, args, options) => {
    calls.push({ args, env: options.env, input: options.input });
    if (args.includes('context'))
      return JSON.stringify([
        { Endpoints: { docker: { Host: 'unix:///tmp/docker.sock' } } },
      ]);
    if (args.includes('image')) return '[{"Id":"sha256:test"}]';
    if (args.includes('ps')) return conflict ? 'container' : '';
    if (args.includes('inspect') && args.includes('container'))
      return JSON.stringify([
        {
          Config: { Labels: { 'com.docker.compose.project': 'wrong' } },
          Mounts: [],
        },
      ]);
    if (args.includes('volume') && args.includes('ls'))
      return retainedVolume ? volume : '';
    return '';
  };
  return { calls, run };
}
test('all operations retain fixed Compose identity and isolate child environment', async () => {
  const { calls, run } = runner();
  const destination = new ComposeDestination(
    '/repo',
    { password: 'dest-secret', port: 1524, startupTimeoutSeconds: 5 },
    undefined,
    run,
  );
  await destination.preflight();
  await destination.reset();
  await destination.start();
  await destination.sql('SELECT 1 FROM dual;');
  for (const call of calls.filter((call) => call.args.includes('compose'))) {
    assert.ok(call.args.includes(project));
    assert.ok(call.args.includes('/repo/docker-compose.yml'));
    assert.ok(call.args.includes('/dev/null'));
    assert.equal(call.env.ORACLE_PASSWORD, undefined);
    assert.equal(call.env.COMPOSE_FILE, undefined);
    assert.equal(call.env.CLONE_DESTINATION_PASSWORD, 'dest-secret');
    assert.ok(!call.args.includes('dest-secret'));
  }
  assert.ok(
    calls.some(
      (call) => call.args.includes(service) && call.input?.includes('SELECT 1'),
    ),
  );
});
test('conflicting container identity and failed volume removal fail closed', async () => {
  const conflicting = new ComposeDestination(
    '/repo',
    { password: 'secret', port: 1524, startupTimeoutSeconds: 5 },
    undefined,
    runner(true).run,
  );
  await assert.rejects(conflicting.preflight(), /CLONE_DESTINATION_MISMATCH/);
  const retained = new ComposeDestination(
    '/repo',
    { password: 'secret', port: 1524, startupTimeoutSeconds: 5 },
    undefined,
    runner(false, true).run,
  );
  await assert.rejects(retained.reset(), /CLONE_RESET_FAILED/);
});

test('generated preamble cannot override replay error handling; body remains byte-for-byte', () => {
  const prefix =
    [
      '-- Generated from oracle-schema-pipeline format 6. Reconstructed from catalog metadata and captured source text.',
      'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
      'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
      'SET DEFINE OFF',
      'SET SQLBLANKLINES ON',
      'SET ECHO ON',
    ].join('\n\n') + '\n\n';
  const body = "CREATE TABLE T (V VARCHAR2(10) DEFAULT '  a  ');\n";
  assert.equal(generatedReplay(prefix + body), 'SET SQLBLANKLINES ON\n' + body);
  assert.throws(
    () => generatedReplay('unknown preamble'),
    /CLONE_STAGE_FAILED/,
  );
});

test('identity refuses altered mounts, foreign volume labels, and extra services', async () => {
  for (const variant of ['mount', 'volume', 'service']) {
    const run: Runner = async (_, args) => {
      if (args.includes('context'))
        return JSON.stringify([
          { Endpoints: { docker: { Host: 'unix:///tmp/docker.sock' } } },
        ]);
      if (args.includes('image')) return '[{"Id":"sha256:test"}]';
      if (args.includes('ps')) return 'container';
      if (args.includes('inspect') && args.includes('container'))
        return JSON.stringify([
          {
            Name: `/${project}-${service}-1`,
            Config: {
              Labels: {
                'com.docker.compose.project': project,
                'com.docker.compose.service':
                  variant === 'service' ? 'foreign' : service,
              },
            },
            Mounts: [
              {
                Type: 'volume',
                Name: variant === 'mount' ? 'foreign-data' : volume,
                Destination: '/opt/oracle/oradata',
              },
            ],
          },
        ]);
      if (args.includes('volume') && args.includes('ls')) return volume;
      if (args.includes('volume') && args.includes('inspect'))
        return JSON.stringify([
          {
            Labels: {
              'com.docker.compose.project': 'foreign',
              'com.docker.compose.volume': 'oracle-destination-data',
            },
          },
        ]);
      return '';
    };
    const destination = new ComposeDestination(
      '/repo',
      { password: 'secret', port: 1522, startupTimeoutSeconds: 5 },
      undefined,
      run,
    );
    await assert.rejects(destination.preflight(), /CLONE_DESTINATION_MISMATCH/);
  }
});
test('remote Docker context is rejected before any resource operation', async () => {
  const calls: string[][] = [];
  const run: Runner = async (_, args) => {
    calls.push(args);
    return JSON.stringify([
      { Endpoints: { docker: { Host: 'ssh://remote' } } },
    ]);
  };
  const priorHost = process.env.DOCKER_HOST,
    priorContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  try {
    await assert.rejects(
      new ComposeDestination(
        '/repo',
        { password: 'secret', port: 1522, startupTimeoutSeconds: 5 },
        undefined,
        run,
      ).preflight(),
      /CLONE_DESTINATION_MISMATCH/,
    );
    assert.equal(calls.length, 1);
  } finally {
    if (priorHost !== undefined) process.env.DOCKER_HOST = priorHost;
    if (priorContext !== undefined) process.env.DOCKER_CONTEXT = priorContext;
  }
});

for (const scenario of [
  'cached',
  'download',
  'silent',
  'pull-failure',
  'inspect-failure',
  'identity-failure',
  'interrupt',
  'inspect-interrupt',
] as const) {
  test(`preflight progress preserves commands and failure boundaries: ${scenario}`, async () => {
    const events: import('../scripts/clone-progress.js').PreflightEvent[] = [];
    const calls: { args: string[]; timeout?: number; observed: boolean }[] = [];
    const base = runner(scenario === 'identity-failure');
    let inspections = 0;
    const run: Runner = async (file, args, options) => {
      calls.push({
        args,
        timeout: options.timeoutMs,
        observed: !!options.onProgressLine,
      });
      if (args.includes('image')) {
        inspections++;
        if (scenario === 'inspect-interrupt')
          throw new CloneError('CLONE_INTERRUPTED');
        if (
          inspections === 1 &&
          ['download', 'silent', 'pull-failure', 'interrupt'].includes(scenario)
        )
          throw Error('private-registry-secret');
        if (inspections === 2 && scenario === 'inspect-failure')
          throw Error('private-inspection-secret');
      }
      if (args.includes('pull')) {
        if (scenario !== 'silent') {
          options.onProgressLine?.({
            stream: 'stderr',
            line: 'abcdef123456: Downloading 1MB/2MB',
          });
          options.onProgressLine?.({
            stream: 'stdout',
            line: 'abcdef123456: Download complete',
          });
          options.onProgressLine?.({
            stream: 'stderr',
            line: 'private-registry-secret',
          });
        }
        if (scenario === 'pull-failure') throw Error('private-pull-secret');
        if (scenario === 'interrupt') throw new CloneError('CLONE_INTERRUPTED');
        return '';
      }
      return base.run(file, args, options);
    };
    const destination = new ComposeDestination(
      '/repo',
      {
        password: 'private-destination-secret',
        port: 1524,
        startupTimeoutSeconds: 5,
      },
      undefined,
      run,
    );
    if (['cached', 'download', 'silent'].includes(scenario))
      assert.equal(
        await destination.preflight((event) => events.push(event)),
        'sha256:test',
      );
    else
      await assert.rejects(
        destination.preflight((event) => events.push(event)),
        scenario.includes('interrupt')
          ? /CLONE_INTERRUPTED/
          : scenario === 'identity-failure'
            ? /CLONE_DESTINATION_MISMATCH/
            : /CLONE_DOCKER_UNAVAILABLE/,
      );
    assert.deepEqual(
      events.slice(0, 6).map((event) => [event.operation, event.event]),
      [
        ['endpoint', 'start'],
        ['endpoint', 'complete'],
        ['daemon', 'start'],
        ['daemon', 'complete'],
        ['compose', 'start'],
        ['compose', 'complete'],
      ],
    );
    const pulled = ['download', 'silent', 'pull-failure', 'interrupt'].includes(
      scenario,
    );
    assert.equal(calls.filter((call) => call.observed).length, pulled ? 1 : 0);
    for (const call of calls) {
      assert.equal(
        call.timeout,
        call.args.includes('pull') ? 1_200_000 : 120_000,
      );
      if (!call.args.includes('context'))
        assert.deepEqual(call.args.slice(0, 2), [
          '--host',
          'unix:///tmp/docker.sock',
        ]);
    }
    assert.equal(
      events.some((event) => event.operation === 'image-pull'),
      pulled,
    );
    assert.equal(
      events.some((event) => event.event === 'layer'),
      pulled && scenario !== 'silent',
    );
    if (
      [
        'pull-failure',
        'inspect-failure',
        'interrupt',
        'inspect-interrupt',
      ].includes(scenario)
    ) {
      assert.ok(
        !events.some(
          (event) => event.operation === 'image' && event.event === 'complete',
        ),
      );
      assert.ok(!events.some((event) => event.operation === 'identity'));
    }
    assert.equal(
      events.at(-1)?.event,
      ['cached', 'download', 'silent'].includes(scenario)
        ? 'complete'
        : 'failure',
    );
    assert.doesNotMatch(JSON.stringify(events), /private-|unix:|sha256/);
    const names = calls.map((call) =>
      call.args.filter(
        (arg) => arg !== '--host' && arg !== 'unix:///tmp/docker.sock',
      ),
    );
    assert.deepEqual(names.slice(0, 3), [
      ['context', 'inspect'],
      ['info', '--format', '{{.ID}}'],
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-p',
        project,
        '-f',
        '/repo/docker-compose.yml',
        'version',
      ],
    ]);
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.length, count);
  });
}

for (const exitFailure of [true, false]) {
  test(`SQL diagnostics retain only codes and setup identity (exit failure: ${exitFailure})`, async () => {
    const output =
      'private SQL and password\nORA-20001: OSP_SETUP_CHECK_2\nORA-06512: at line 1\n';
    const destination = new ComposeDestination(
      '/repo',
      {
        password: 'private-password',
        port: 1524,
        startupTimeoutSeconds: 5,
      },
      undefined,
      async (_, __, options) => {
        for (const line of output.trim().split('\n'))
          options.onProgressLine?.({ stream: 'stdout', line });
        if (exitFailure) throw new CloneError('CLONE_STAGE_FAILED', 1);
        return output;
      },
    );
    await assert.rejects(
      destination.sql('SELECT 1 FROM dual;'),
      (error: unknown) => {
        assert.ok(error instanceof CloneError);
        assert.deepEqual(error.sqlDiagnostics, {
          oracleCodes: ['ORA-20001', 'ORA-06512'],
          setupCheckIndex: 2,
        });
        assert.equal(error.childExitCode, exitFailure ? 1 : undefined);
        assert.doesNotMatch(JSON.stringify(error), /private/);
        return true;
      },
    );
  });
}

test('SQL diagnostic parser rejects unknown text and preserves interruption', async () => {
  for (const code of ['CLONE_STAGE_FAILED', 'CLONE_INTERRUPTED']) {
    const destination = new ComposeDestination(
      '/repo',
      {
        password: 'secret',
        port: 1524,
        startupTimeoutSeconds: 5,
      },
      undefined,
      async (_, __, options) => {
        options.onProgressLine?.({
          stream: 'stderr',
          line: 'secret OSP_SETUP_CHECK_0',
        });
        throw new CloneError(code);
      },
    );
    await assert.rejects(
      destination.sql('SELECT 1 FROM dual;'),
      (error: unknown) => {
        assert.ok(error instanceof CloneError);
        assert.equal(error.code, code);
        assert.equal(error.sqlDiagnostics?.setupCheckIndex, undefined);
        assert.doesNotMatch(JSON.stringify(error), /secret/);
        return true;
      },
    );
  }
});

test('program compilation markers retain only numeric context and warnings do not fail replay', async () => {
  const warnings: unknown[] = [];
  const destination = new ComposeDestination(
    '/repo',
    { password: 'secret', port: 1524, startupTimeoutSeconds: 5 },
    undefined,
    async (_, __, options) => {
      options.onProgressLine?.({
        stream: 'stdout',
        line: 'PLSQL_COMPILE_WARNING:2:7:3:6002',
      });
      options.onProgressLine?.({
        stream: 'stdout',
        line: 'PLSQL_COMPILE_WARNING:2:7:3:6002 secret source',
      });
      return 'PLSQL_COMPILE_WARNING:2:7:3:6002\n';
    },
  );
  await destination.sql('SELECT 1 FROM dual;', (warning) =>
    warnings.push(warning),
  );
  assert.deepEqual(warnings, [
    { operationIndex: 2, line: 7, position: 3, messageNumber: 6002 },
  ]);
  const failure = new ComposeDestination(
    '/repo',
    { password: 'secret', port: 1524, startupTimeoutSeconds: 5 },
    undefined,
    async (_, __, options) => {
      options.onProgressLine?.({
        stream: 'stdout',
        line: 'ORA-20020: PLSQL_COMPILE_FAILED:4:9:2:201',
      });
      throw new CloneError('CLONE_STAGE_FAILED', 1);
    },
  );
  await assert.rejects(failure.sql('SELECT 1 FROM dual;'), (error: unknown) => {
    assert.ok(error instanceof CloneError);
    assert.deepEqual(error.sqlDiagnostics?.programFailure, {
      operationIndex: 4,
      line: 9,
      position: 2,
      messageNumber: 201,
    });
    assert.doesNotMatch(JSON.stringify(error), /secret|source/u);
    return true;
  });
});
