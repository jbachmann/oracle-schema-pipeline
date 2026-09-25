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
import type { Runner } from '../scripts/process.js';
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
      '-- Generated from oracle-schema-pipeline format 4. No source DDL was replayed.',
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
