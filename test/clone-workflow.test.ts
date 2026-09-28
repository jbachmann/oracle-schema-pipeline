import {
  setupRequirements,
  setupChecks,
} from '../scripts/compose-destination.js';
import * as fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloneDatabase as workflow,
  runResultSchema,
  type WorkflowOptions,
} from '../scripts/clone-workflow.js';
import { CloneError, type Runner } from '../scripts/process.js';
import { writeJson, writeNewFile } from '../src/files.js';
import { generateSql } from '../src/generate.js';
import { transformSource } from '../src/transform.js';
import { sourceDocumentSchema, policySchema } from '../src/model.js';
import { publishArtifacts, jsonBytes } from '../src/files.js';
const cloneDatabase = (options: WorkflowOptions) =>
  workflow({
    ...options,
    lockPath:
      options.lockPath ?? join(options.root, 'artifacts/.db-clone.lock'),
  });
const source = sourceDocumentSchema.parse(
  JSON.parse(
    await readFile(
      fileURLToPath(new URL('../examples/source.json', import.meta.url)),
      'utf8',
    ),
  ),
);
async function fixture(prerequisite = false) {
  const root = await mkdtemp(join(tmpdir(), 'clone-workflow-'));
  await mkdir(join(root, 'config/local'), { recursive: true });
  await writeFile(
    join(root, 'config/local/config.json'),
    JSON.stringify({
      version: 1,
      source: { user: 'APP', password: 'source-secret', dsn: 'host/SERVICE' },
      destination: { password: 'dest-secret' },
      ...(prerequisite ? { prerequisiteSql: 'setup.sql' } : {}),
    }),
  );
  await writeFile(
    join(root, 'config/local/objects.json'),
    JSON.stringify({
      version: 2,
      tables: source.targetTables,
      views: source.targetViews,
    }),
  );
  await writeFile(join(root, 'config/local/policy.json'), '{}');
  if (prerequisite)
    await writeFile(
      join(root, 'config/local/setup.sql'),
      'SELECT 1 FROM dual;',
    );
  return root;
}
function seams(
  failure?: string,
  controller?: AbortController,
  policy = policySchema.parse({}),
) {
  const order: string[] = [],
    environments: NodeJS.ProcessEnv[] = [];
  const run: Runner = async (_, args, options) => {
    const stage = args[3];
    order.push(stage);
    environments.push(options.env);
    if (stage === failure) throw new CloneError('CLONE_STAGE_FAILED', 2);
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const publication = { tempDir: arg('--temp-dir') };
    if (stage === 'extract')
      await writeJson(arg('--output'), source, publication);
    if (stage === 'dictionary')
      await writeNewFile(arg('--output'), 'workbook', publication);
    if (stage === 'transform') {
      const target = transformSource(source, policy);
      await publishArtifacts(
        [
          {
            role: 'target',
            path: arg('--output'),
            contents: jsonBytes(target),
          },
          { role: 'report', path: arg('--report'), contents: jsonBytes({}) },
        ],
        `${arg('--output')}.complete.json`,
        publication,
      );
    }
    if (stage === 'generate') {
      await writeNewFile(
        arg('--output'),
        generateSql(transformSource(source, policy)),
        publication,
      );
      if (controller) controller.abort();
    }
    return '';
  };
  let sqlIndex = 0;
  const operation = async (name: string) => {
    order.push(name);
    if (name === failure) throw new CloneError('CLONE_STAGE_FAILED', 1);
  };
  const destination = () => ({
    preflight: async () => {
      await operation('preflight');
      return 'sha256:test';
    },
    identity: () => operation('identity'),
    reset: () => operation('reset'),
    start: () => operation('startup'),
    sql: async (sql: string) => {
      await operation(
        sql.includes('DEFERRED_SEGMENT_CREATION')
          ? 'replay'
          : `sql-${++sqlIndex}`,
      );
    },
  });
  return { run, destination, order, environments };
}
test('successful run publishes complete artifacts, isolates secrets, and never overwrites runs', async () => {
  const root = await fixture();
  const seam = seams();
  const logs: string[] = [];
  const first = await cloneDatabase({
    root,
    ...seam,
    log: (line) => logs.push(line),
  });
  assert.equal(first.result.status, 'succeeded');
  assert.deepEqual(seam.order, [
    'preflight',
    'extract',
    'dictionary',
    'transform',
    'validate',
    'generate',
    'identity',
    'reset',
    'startup',
    'sql-1',
    'replay',
    'sql-2',
  ]);
  assert.equal(seam.environments[0].ORACLE_PASSWORD, 'source-secret');
  for (const env of seam.environments.slice(1))
    assert.equal(env.ORACLE_PASSWORD, undefined);
  const stored = await readFile(
    join(first.directory, 'run-result.json'),
    'utf8',
  );
  runResultSchema.parse(JSON.parse(stored));
  assert.doesNotMatch(
    stored + logs.join(),
    /source-secret|dest-secret|host\/SERVICE/,
  );
  const second = await cloneDatabase({ root, ...seams(), log: () => {} });
  assert.notEqual(first.directory, second.directory);
  assert.equal(
    await readFile(join(first.directory, 'run-result.json'), 'utf8'),
    stored,
  );
});
for (const failedStage of [
  'preflight',
  'extract',
  'dictionary',
  'transform',
  'validate',
  'generate',
  'identity',
])
  test(`${failedStage} failure preserves destination`, async () => {
    const seam = seams(failedStage);
    const { result } = await cloneDatabase({
      root: await fixture(),
      ...seam,
      log: () => {},
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.destinationResetStarted, false);
    assert.ok(!seam.order.includes('reset'));
    assert.ok(
      !seam.order.some(
        (operation) =>
          operation === 'startup' ||
          operation === 'replay' ||
          operation.startsWith('sql-'),
      ),
    );
  });
for (const [failedStage, code] of [
  ['reset', 'CLONE_RESET_FAILED'],
  ['startup', 'CLONE_STARTUP_FAILED'],
  ['sql-1', 'CLONE_PREREQUISITE_FAILED'],
  ['replay', 'CLONE_REPLAY_FAILED'],
  ['sql-2', 'CLONE_VERIFICATION_FAILED'],
])
  test(`${failedStage} failure cannot report success`, async () => {
    const seam = seams(failedStage);
    const { result } = await cloneDatabase({
      root: await fixture(),
      ...seam,
      log: () => {},
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, code);
    assert.equal(result.destinationResetStarted, true);
    if (failedStage === 'reset') assert.ok(!seam.order.includes('startup'));
    if (failedStage === 'sql-1') assert.ok(!seam.order.includes('replay'));
  });
test('prerequisite runs before replay, records only hash and length', async () => {
  const seam = seams();
  const { result } = await cloneDatabase({
    root: await fixture(true),
    ...seam,
    log: () => {},
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.prerequisite?.sha256.length, 64);
  assert.ok(seam.order.indexOf('sql-2') < seam.order.indexOf('replay'));
});
test('signal after generation stops before reset and releases owned lock', async () => {
  const root = await fixture(),
    controller = new AbortController(),
    seam = seams(undefined, controller);
  const { result } = await cloneDatabase({
    root,
    ...seam,
    signal: controller.signal,
    log: () => {},
  });
  assert.equal(result.errorCode, 'CLONE_INTERRUPTED');
  assert.ok(!seam.order.includes('reset'));
  await assert.rejects(access(join(root, 'artifacts/.db-clone.lock')));
});
test('existing lock fails before extraction and remains untouched', async () => {
  const root = await fixture();
  await mkdir(join(root, 'artifacts'));
  await writeFile(join(root, 'artifacts/.db-clone.lock'), 'other-run');
  const seam = seams();
  const { result } = await cloneDatabase({ root, ...seam, log: () => {} });
  assert.equal(result.errorCode, 'CLONE_ALREADY_RUNNING');
  assert.deepEqual(seam.order, []);
  assert.equal(
    await readFile(join(root, 'artifacts/.db-clone.lock'), 'utf8'),
    'other-run',
  );
});

test('loss of lock ownership stops reset and never removes the replacement lock', async () => {
  const root = await fixture(),
    seam = seams();
  const run: Runner = async (file, args, options) => {
    const output = await seam.run(file, args, options);
    if (args[3] === 'generate')
      await writeFile(
        join(root, 'artifacts/.db-clone.lock'),
        'replacement-owner',
      );
    return output;
  };
  const { result } = await cloneDatabase({ root, ...seam, run, log: () => {} });
  assert.equal(result.errorCode, 'CLONE_ALREADY_RUNNING');
  assert.equal(result.destinationResetStarted, false);
  assert.equal(
    await readFile(join(root, 'artifacts/.db-clone.lock'), 'utf8'),
    'replacement-owner',
  );
});
test('interruption after reset records partial destination and prevents replay', async () => {
  const root = await fixture(),
    seam = seams(),
    controller = new AbortController();
  const destination = () => {
    const dest = seam.destination();
    return {
      ...dest,
      start: async () => {
        await dest.start();
        controller.abort();
      },
    };
  };
  const { result } = await cloneDatabase({
    root,
    ...seam,
    destination,
    signal: controller.signal,
    log: () => {},
  });
  assert.equal(result.errorCode, 'CLONE_INTERRUPTED');
  assert.equal(result.destinationResetStarted, true);
  assert.ok(!seam.order.includes('replay'));
});

test('child publication codes survive without leaking raw error contents', async () => {
  const seam = seams();
  const run: Runner = async (file, args, options) => {
    if (args[3] === 'generate') {
      options.onLine?.('OUTPUT_EXISTS: private-secret-location');
      throw new CloneError('CLONE_STAGE_FAILED', 1);
    }
    return seam.run(file, args, options);
  };
  const { result } = await cloneDatabase({
    root: await fixture(),
    ...seam,
    run,
    log: () => {},
  });
  assert.equal(result.errorCode, 'OUTPUT_EXISTS');
  assert.equal(result.childExitCode, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-secret/);
});

test('different checkouts sharing a destination lock cannot run concurrently', async () => {
  const firstRoot = await fixture(),
    secondRoot = await fixture();
  const lockPath = join(firstRoot, 'shared-destination.lock');
  const firstSeam = seams(),
    secondSeam = seams();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const destination = () => ({
    ...firstSeam.destination(),
    preflight: async () => {
      entered();
      await blocked;
      return 'sha256:test';
    },
  });
  const first = cloneDatabase({
    root: firstRoot,
    lockPath,
    ...firstSeam,
    destination,
    log: () => {},
  });
  await started;
  const second = await cloneDatabase({
    root: secondRoot,
    lockPath,
    ...secondSeam,
    log: () => {},
  });
  release();
  assert.equal(second.result.errorCode, 'CLONE_ALREADY_RUNNING');
  assert.deepEqual(secondSeam.order, []);
  assert.equal((await first).result.status, 'succeeded');
});

test('preflight formats safe progress through the injected logger and failure blocks extraction and reset', async () => {
  const root = await fixture(),
    seam = seams(),
    logs: string[] = [];
  const { PreflightProgress } = await import('../scripts/clone-progress.js');
  const destination = seam.destination();
  const { result, directory } = await cloneDatabase({
    root,
    ...seam,
    destination: () => ({
      ...destination,
      preflight: (observer) =>
        new PreflightProgress(observer).operation('daemon', async () => {
          throw new CloneError('CLONE_DOCKER_UNAVAILABLE');
        }),
    }),
    log: (line) => logs.push(line),
  });
  assert.ok(logs.includes('Preflight: Docker daemon — starting'));
  assert.ok(
    logs.some((line) =>
      /^Preflight: Docker daemon — failed \([\d.]+s\)$/.test(line),
    ),
  );
  assert.deepEqual(seam.order, []);
  const stored = await readFile(join(directory, 'run-result.json'), 'utf8');
  runResultSchema.parse(JSON.parse(stored));
  assert.doesNotMatch(
    logs.join('\n') + stored,
    /source-secret|dest-secret|host\/SERVICE|elapsedMs|heartbeat/,
  );
  assert.equal(result.status, 'failed');
});

test('clone displays extraction summaries from stderr progress records', async () => {
  const seam = seams(),
    logs: string[] = [];
  const run: Runner = async (file, args, options) => {
    if (args[3] === 'extract') {
      for (const [stage, event] of [
        ['extract', 'start'],
        ['query', 'complete'],
        ['object', 'complete'],
        ['extract', 'complete'],
      ]) {
        options.onProgressLine?.({
          stream: 'stderr',
          line: JSON.stringify({ version: 1, stage, event }),
        });
      }
      options.onProgressLine?.({
        stream: 'stdout',
        line: JSON.stringify({
          version: 1,
          stage: 'extract',
          event: 'failure',
        }),
      });
    }
    return seam.run(file, args, options);
  };
  const { result } = await cloneDatabase({
    root: await fixture(),
    ...seam,
    run,
    log: (line) => logs.push(line),
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(logs.includes('Extraction extract: start'));
  assert.ok(
    logs.some((line) =>
      /Extraction extract: complete .*1 queries completed; 1 objects completed/.test(
        line,
      ),
    ),
  );
  assert.ok(!logs.some((line) => line.includes('Extraction extract: failure')));
});

test('retry replays retained SQL, shares lifecycle, ignores unusable source and preserves earlier attempts', async () => {
  const { retryCloneDatabase } = await import('../scripts/clone-workflow.js');
  const { generatedReplay } = await import('../scripts/compose-destination.js');
  const root = await fixture(true);
  const first = await cloneDatabase({
    root,
    ...seams('replay'),
    log: () => {},
  });
  const names = [
    'clone.sql',
    'target.json',
    'report.json',
    'target.json.complete.json',
    'run-result.json',
  ];
  const original = await Promise.all(
    names.map((name) => readFile(join(first.directory, name))),
  );
  await writeFile(
    join(root, 'config/local/config.json'),
    JSON.stringify({
      version: 1,
      source: null,
      objects: 'missing',
      policy: 'missing',
      destination: { password: 'dest-secret' },
      prerequisiteSql: 'setup.sql',
    }),
  );
  await writeFile(join(root, 'config/local/setup.sql'), 'SELECT 2 FROM dual;');
  const seam = seams(),
    sql: string[] = [],
    logs: string[] = [];
  const dest = seam.destination();
  const retry = await retryCloneDatabase({
    root,
    input: first.directory,
    lockPath: join(root, 'artifacts/.db-clone.lock'),
    run: async () => {
      throw new Error('Pipeline must never run');
    },
    destination: (loaded) => {
      assert.equal('source' in loaded.config, false);
      return {
        ...dest,
        sql: async (text) => {
          sql.push(text);
          await dest.sql(text);
        },
      };
    },
    log: (line) => logs.push(line),
  });
  assert.equal(retry.result.status, 'succeeded');
  assert.match(retry.directory, /db-clone-retry-/);
  assert.deepEqual(seam.order, [
    'preflight',
    'identity',
    'reset',
    'startup',
    'sql-1',
    'sql-2',
    'replay',
    'sql-3',
  ]);
  assert.equal(sql[0], 'SELECT 2 FROM dual;');
  assert.equal(sql[2], generatedReplay(original[0].toString()));
  assert.notEqual(
    retry.result.prerequisite?.sha256,
    first.result.prerequisite?.sha256,
  );
  assert.deepEqual(
    logs.filter((line) => line.startsWith('Clone stage:')),
    [
      'retry-input',
      'config',
      'preflight',
      'reset-preflight',
      'reset',
      'startup',
      'prerequisite',
      'setup-verification',
      'replay',
      'verification',
    ].map((stage) => `Clone stage: ${stage}`),
  );
  const next = await retryCloneDatabase({
    root,
    input: retry.directory,
    lockPath: join(root, 'artifacts/.db-clone.lock'),
    ...seams(),
    log: () => {},
  });
  assert.equal(next.result.status, 'succeeded');
  assert.notEqual(next.directory, retry.directory);
  for (const [index, name] of names.entries())
    assert.deepEqual(
      await readFile(join(first.directory, name)),
      original[index],
    );
});
for (const [failure, code] of [
  ['preflight', 'CLONE_DOCKER_UNAVAILABLE'],
  ['identity', 'CLONE_STAGE_FAILED'],
  ['reset', 'CLONE_RESET_FAILED'],
  ['startup', 'CLONE_STARTUP_FAILED'],
  ['sql-1', 'CLONE_PREREQUISITE_FAILED'],
  ['sql-2', 'CLONE_PREREQUISITE_FAILED'],
  ['replay', 'CLONE_REPLAY_FAILED'],
  ['sql-3', 'CLONE_VERIFICATION_FAILED'],
])
  test(`retry ${failure} failure preserves correct result and exit code`, async () => {
    const { retryCloneDatabase } = await import('../scripts/clone-workflow.js');
    const root = await fixture(true);
    const first = await cloneDatabase({ root, ...seams(), log: () => {} });
    const retry = await retryCloneDatabase({
      root,
      input: first.directory,
      lockPath: join(root, 'artifacts/.db-clone.lock'),
      ...seams(failure),
      log: () => {},
    });
    assert.equal(retry.result.status, 'failed');
    assert.equal(retry.result.errorCode, code);
    assert.equal(retry.result.childExitCode, 1);
    assert.equal(
      retry.result.destinationResetStarted,
      !['preflight', 'identity'].includes(failure),
    );
  });
test('retry invalid input and snapshot publication failure never reach destination', async () => {
  const { retryCloneDatabase } = await import('../scripts/clone-workflow.js');
  const root = await fixture();
  const first = await cloneDatabase({ root, ...seams(), log: () => {} });
  const seam = seams();
  const failed = await retryCloneDatabase({
    root,
    input: 'nonexistent',
    ...seam,
    lockPath: join(root, 'artifacts/.db-clone.lock'),
    log: () => {},
  });
  assert.equal(failed.result.errorCode, 'OUTPUT_INCOMPLETE');
  assert.equal(failed.result.destinationResetStarted, false);
  // Force the shared publisher to reject snapshot staging in this attempt.
  const blocked = await retryCloneDatabase({
    root,
    input: first.directory,
    ...seam,
    lockPath: join(root, 'artifacts/.db-clone.lock'),
    log: (line) => {
      if (line === 'Clone stage: retry-input') {
        // A synchronous hook runs before input preparation begins.
        for (const name of fs.readdirSync(join(root, 'artifacts'))) {
          if (
            name.startsWith('db-clone-retry-') &&
            !fs.existsSync(join(root, 'artifacts', name, 'run-result.json'))
          )
            fs.writeFileSync(
              join(root, 'artifacts', name, 'clone.sql'),
              'occupied',
            );
        }
      }
    },
  });
  assert.equal(blocked.result.errorCode, 'OUTPUT_EXISTS');
  assert.equal(blocked.result.destinationResetStarted, false);
  assert.deepEqual(seam.order, []);
});

test('normal and retry attempts contend for the same lock; retry cancellation releases it', async () => {
  const { retryCloneDatabase } = await import('../scripts/clone-workflow.js');
  const root = await fixture();
  const first = await cloneDatabase({ root, ...seams(), log: () => {} });
  const lockPath = join(root, 'artifacts/.db-clone.lock');
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const seam = seams();
  const retry = retryCloneDatabase({
    root,
    input: first.directory,
    lockPath,
    signal: controller.signal,
    ...seam,
    destination: () => ({
      ...seam.destination(),
      preflight: async () => {
        entered();
        await blocked;
        return 'sha256:test';
      },
    }),
    log: () => {},
  });
  await started;
  try {
    const contender = await cloneDatabase({
      root,
      lockPath,
      ...seams(),
      log: () => {},
    });
    assert.equal(contender.result.errorCode, 'CLONE_ALREADY_RUNNING');
  } finally {
    controller.abort();
    release();
  }
  const cancelled = await retry;
  assert.equal(cancelled.result.errorCode, 'CLONE_INTERRUPTED');
  assert.equal(cancelled.result.destinationResetStarted, false);
  await assert.rejects(access(lockPath));
  runResultSchema.parse(
    JSON.parse(
      await readFile(join(cancelled.directory, 'run-result.json'), 'utf8'),
    ),
  );
});

test('retry interruption after reset retains partial destination status and publishes failure', async () => {
  const { retryCloneDatabase } = await import('../scripts/clone-workflow.js');
  const root = await fixture();
  const first = await cloneDatabase({ root, ...seams(), log: () => {} });
  const controller = new AbortController(),
    seam = seams();
  const result = await retryCloneDatabase({
    root,
    input: first.directory,
    lockPath: join(root, 'artifacts/.db-clone.lock'),
    signal: controller.signal,
    ...seam,
    destination: () => ({
      ...seam.destination(),
      start: async () => {
        controller.abort();
      },
    }),
    log: () => {},
  });
  assert.equal(result.result.errorCode, 'CLONE_INTERRUPTED');
  assert.equal(result.result.destinationResetStarted, true);
  assert.ok(!seam.order.includes('replay'));
  assert.equal(
    JSON.parse(
      await readFile(join(result.directory, 'run-result.json'), 'utf8'),
    ).status,
    'failed',
  );
});

test('setup verification reports each unmet requirement', async () => {
  const target = transformSource(source, policySchema.parse({}));
  const requirements = setupRequirements(target);
  assert.equal(requirements.length, 2);
  assert.doesNotMatch(setupChecks(target), /dba_users/);
  assert.match(setupChecks(target), /OSP_SETUP_CHECK_0/);
  for (const [index, requirement] of requirements.entries()) {
    const root = await fixture();
    const seam = seams();
    const messages: string[] = [];
    const result = await cloneDatabase({
      root,
      run: seam.run,
      log: (message) => messages.push(message),
      destination: () => ({
        ...seam.destination(),
        sql: async () => {
          throw new CloneError('CLONE_STAGE_FAILED', 1, {
            oracleCodes: ['ORA-20001'],
            setupCheckIndex: index,
          });
        },
      }),
    });
    assert.equal(result.result.errorCode, 'CLONE_PREREQUISITE_FAILED');
    assert.equal(result.result.lastStage, 'setup-verification');
    const expected = requirement.detail;
    assert.equal(result.result.errorDetail, expected);
    assert.ok(messages.includes(expected));
    assert.deepEqual(result.result.oracleErrorCodes, ['ORA-20001']);
    assert.equal(
      runResultSchema.parse(
        JSON.parse(
          await readFile(join(result.directory, 'run-result.json'), 'utf8'),
        ),
      ).errorDetail,
      expected,
    );
    assert.ok(requirement.detail.length > 0);
  }
});

test('external prerequisite failures retain their indexed detail with required owners', async () => {
  const policy = policySchema.parse({
    createSchemas: false,
    externalPrerequisites: [
      { reference: { owner: 'APP', name: 'SEQ' }, type: 'SEQUENCE' },
    ],
  });
  const requirements = setupRequirements(transformSource(source, policy));
  const index = requirements.length - 1;
  const root = await fixture(true);
  await writeFile(
    join(root, 'config/local/policy.json'),
    JSON.stringify(policy),
  );
  const seam = seams(undefined, undefined, policy);
  const result = await cloneDatabase({
    root,
    run: seam.run,
    log: () => {},
    destination: () => ({
      ...seam.destination(),
      sql: async (sql: string) => {
        if (!sql.includes('OSP_SETUP_CHECK_')) return;
        throw new CloneError('CLONE_STAGE_FAILED', 1, {
          oracleCodes: ['ORA-20001'],
          setupCheckIndex: index,
        });
      },
    }),
  });
  assert.equal(result.result.lastStage, 'setup-verification');
  assert.equal(result.result.errorDetail, requirements[index].detail);
  assert.match(result.result.errorDetail!, /External prerequisite SEQUENCE/);
});

test('setup requirements explain preprovisioned schemas and external objects', () => {
  const target = transformSource(
    source,
    policySchema.parse({ createSchemas: false }),
  );
  target.policy.externalPrerequisites = [
    { reference: { owner: 'APP', name: 'SEQ' }, type: 'SEQUENCE' },
  ];
  const requirements = setupRequirements(target);
  assert.ok(
    requirements.some((item) =>
      /missing.*createSchemas=false/.test(item.detail),
    ),
  );
  assert.match(
    requirements.at(-1)!.detail,
    /SEQUENCE "APP"."SEQ".*missing or not VALID/,
  );
  assert.match(
    setupChecks(target),
    new RegExp(`OSP_SETUP_CHECK_${requirements.length - 1}`),
  );
  assert.equal(
    requirements.length,
    3 + new Set(target.tables.map((table) => table.reference.owner)).size,
  );
  assert.equal(requirements.at(-1)!.expected, 1);
});

test('unknown setup failures provide guidance without claiming a particular condition failed', async () => {
  const root = await fixture();
  const seam = seams('sql-1');
  const { result } = await cloneDatabase({ root, ...seam, log: () => {} });
  assert.match(result.errorDetail!, /could not complete/);
  assert.equal(result.oracleErrorCodes, undefined);
});
