import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  unlink,
  cp,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  prepareRetryInput,
  retryInputSchema,
} from '../scripts/clone-retry-input.js';
import { publishArtifacts, jsonBytes } from '../src/files.js';
import { verifyCompletion } from '../src/completion.js';
import { sourceDocumentSchema, policySchema } from '../src/model.js';
import { transformSource } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { generatedReplay } from '../scripts/compose-destination.js';
const source = sourceDocumentSchema.parse(
  JSON.parse(
    await readFile(new URL('../examples/source.json', import.meta.url), 'utf8'),
  ),
);
async function fixture(
  change?: (target: ReturnType<typeof transformSource>) => unknown,
  report = jsonBytes({}),
  targetBytes?: Buffer,
) {
  const root = await mkdtemp(join(tmpdir(), 'retry-input-'));
  const input = join(root, 'original'),
    output = join(root, 'retry');
  await mkdir(input);
  await mkdir(output);
  const target = transformSource(source, policySchema.parse({}));
  await publishArtifacts(
    [
      {
        role: 'target',
        path: join(input, 'target.json'),
        contents: targetBytes ?? jsonBytes(change ? change(target) : target),
      },
      { role: 'report', path: join(input, 'report.json'), contents: report },
    ],
    join(input, 'target.json.complete.json'),
    { tempDir: join(root, 'staging') },
  );
  await writeFile(join(input, 'clone.sql'), generateSql(target));
  return { root, input, output };
}
test('retry snapshots exact independent bytes without a result or provenance and can itself be retried', async () => {
  const { root, input, output } = await fixture();
  const result = await prepareRetryInput(input, output);
  const record = retryInputSchema.parse(
    JSON.parse(await readFile(join(output, 'retry-input.json'), 'utf8')),
  );
  for (const [index, name] of [
    'clone.sql',
    'target.json',
    'report.json',
  ].entries()) {
    const bytes = await readFile(join(input, name));
    assert.deepEqual(await readFile(join(output, name)), bytes);
    assert.notEqual(
      (await stat(join(input, name))).ino,
      (await stat(join(output, name))).ino,
    );
    assert.equal(record.artifacts[index].bytes, bytes.length);
    assert.equal(
      record.artifacts[index].sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
  }
  assert.equal(
    result.sql,
    generatedReplay(await readFile(join(input, 'clone.sql'), 'utf8')),
  );
  const next = join(root, 'next');
  await mkdir(next);
  await prepareRetryInput(output, next);
  await verifyCompletion(
    join(next, 'target.json.complete.json'),
    ['target', 'report'].map((role) => ({
      role,
      path: join(next, `${role}.json`),
    })),
  );
});
test('retry preserves legacy unconditional user creation without regenerating SQL', async () => {
  const { input, output } = await fixture();
  const path = join(input, 'clone.sql');
  const current = await readFile(path, 'utf8');
  const legacy = current.replace(
    /DECLARE\n  n NUMBER;[\s\S]*?END;\n\//g,
    (block) => {
      const statement = /EXECUTE IMMEDIATE '((?:[^']|'')*)';/.exec(block)![1];
      return statement.replaceAll("''", "'") + ';';
    },
  );
  assert.notEqual(legacy, current);
  await writeFile(path, legacy);
  const result = await prepareRetryInput(input, output);
  assert.equal(result.sql, generatedReplay(legacy));
  assert.equal(await readFile(join(output, 'clone.sql'), 'utf8'), legacy);
  assert.equal(await readFile(path, 'utf8'), legacy);
  assert.doesNotMatch(result.sql, /ALL_USERS|IF NOT EXISTS/);
});
for (const name of [
  'clone.sql',
  'target.json',
  'report.json',
  'target.json.complete.json',
]) {
  test(`missing ${name} fails safely`, async () => {
    const { input, output } = await fixture();
    await unlink(join(input, name));
    await assert.rejects(
      prepareRetryInput(input, output),
      new RegExp(
        name === 'clone.sql'
          ? 'CLONE_RETRY_INPUT_INVALID'
          : 'OUTPUT_INCOMPLETE',
      ),
    );
  });
}
for (const sql of ['SELECT 1 FROM dual;', Buffer.from([0xff])]) {
  test('unsupported SQL preamble or UTF-8 is rejected', async () => {
    const { input, output } = await fixture();
    await writeFile(join(input, 'clone.sql'), sql);
    await assert.rejects(
      prepareRetryInput(input, output),
      /CLONE_RETRY_INPUT_INVALID/,
    );
  });
}
for (const change of [
  () => null,
  (target: ReturnType<typeof transformSource>) => ({
    ...target,
    formatVersion: 1,
  }),
  (target: ReturnType<typeof transformSource>) => ({
    ...target,
    tables: [...target.tables, target.tables[0]],
  }),
]) {
  test('invalid model or blocking semantic diagnostics reject before publication', async () => {
    const { input, output } = await fixture(change);
    await assert.rejects(
      prepareRetryInput(input, output),
      /CLONE_RETRY_INPUT_INVALID/,
    );
    await assert.rejects(readFile(join(output, 'clone.sql')));
  });
}
for (const report of [Buffer.from('{'), Buffer.from([0xff])]) {
  test('malformed report is rejected even with a matching manifest', async () => {
    const { input, output } = await fixture(undefined, report);
    await assert.rejects(
      prepareRetryInput(input, output),
      /CLONE_RETRY_INPUT_INVALID/,
    );
  });
}
test('changed bytes and relocated bundles fail completion verification', async () => {
  const { root, input, output } = await fixture();
  const moved = join(root, 'moved');
  await cp(input, moved, { recursive: true });
  await assert.rejects(prepareRetryInput(moved, output), /OUTPUT_INCOMPLETE/);
  await writeFile(join(input, 'target.json'), '{}');
  await assert.rejects(prepareRetryInput(input, output), /OUTPUT_INCOMPLETE/);
});
test('exclusive publication rejects occupied output and leaves originals unchanged', async () => {
  const { input, output } = await fixture();
  const original = await readFile(join(input, 'clone.sql'));
  await writeFile(join(output, 'clone.sql'), 'occupied');
  await assert.rejects(prepareRetryInput(input, output), /OUTPUT_EXISTS/);
  assert.deepEqual(await readFile(join(input, 'clone.sql')), original);
});

for (const targetBytes of [Buffer.from('{'), Buffer.from([0xff])]) {
  test('malformed target JSON or UTF-8 fails with a matching manifest', async () => {
    const { input, output } = await fixture(undefined, undefined, targetBytes);
    await assert.rejects(
      prepareRetryInput(input, output),
      /CLONE_RETRY_INPUT_INVALID/,
    );
  });
}
test('invalid completion JSON is rejected', async () => {
  const { input, output } = await fixture();
  await writeFile(join(input, 'target.json.complete.json'), '{');
  await assert.rejects(prepareRetryInput(input, output), /OUTPUT_INCOMPLETE/);
});
test('retry provenance rejects extra fields, reordered roles and unsafe byte lengths', () => {
  const artifacts = ['sql', 'target', 'report'].map((role) => ({
    role,
    bytes: 0,
    sha256: 'a'.repeat(64),
  }));
  assert.ok(retryInputSchema.safeParse({ version: 1, artifacts }).success);
  assert.equal(
    retryInputSchema.safeParse({ version: 1, artifacts, path: 'private' })
      .success,
    false,
  );
  assert.equal(
    retryInputSchema.safeParse({
      version: 1,
      artifacts: [...artifacts].reverse(),
    }).success,
    false,
  );
  assert.equal(
    retryInputSchema.safeParse({
      version: 1,
      artifacts: artifacts.map((item) => ({
        ...item,
        bytes: Number.MAX_SAFE_INTEGER + 1,
      })),
    }).success,
    false,
  );
});

test('completion verification checks retained bytes against the manifest even when disk contents match', async () => {
  const { input } = await fixture();
  await assert.rejects(
    verifyCompletion(join(input, 'target.json.complete.json'), [
      {
        role: 'target',
        path: join(input, 'target.json'),
        contents: Buffer.from('{}'),
      },
      { role: 'report', path: join(input, 'report.json') },
    ]),
    /OUTPUT_INCOMPLETE/,
  );
});
