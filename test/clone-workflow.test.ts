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
function seams(failure?: string, controller?: AbortController) {
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
      const target = transformSource(source, policySchema.parse({}));
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
        generateSql(transformSource(source, policySchema.parse({}))),
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
