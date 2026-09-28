import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  writeFile,
  readdir,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
test('retry CLI help and usage do not load configuration or allocate artifacts', async () => {
  const root = await setup();
  for (const args of [['--help'], [], ['one', 'two'], ['--unknown']]) {
    const result = invoke(root, args);
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
    assert.match(
      result.stdout + result.stderr,
      /Usage: npm run db:clone-retry/,
    );
    if (args[0] !== '--help') assert.match(result.stderr, /CLONE_RETRY_USAGE/);
    assert.ok(!(await readdir(root)).includes('artifacts'));
  }
});
test('retry CLI resolves relative positional paths with spaces from invoking directory', async () => {
  const root = await setup();
  const cwd = join(root, 'working directory');
  await mkdir(cwd);
  const input = join(cwd, 'saved artifacts');
  await mkdir(input);
  const { publishArtifacts, jsonBytes } = await import('../src/files.js');
  // A matching bundle with an invalid target proves that relative resolution reached input validation.
  await publishArtifacts(
    ['target', 'report'].map((role) => ({
      role,
      path: join(input, `${role}.json`),
      contents: jsonBytes({}),
    })),
    join(input, 'target.json.complete.json'),
    { tempDir: join(root, 'staging') },
  );
  await writeFile(join(input, 'clone.sql'), 'invalid preamble');
  const result = invoke(root, ['saved artifacts'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLONE_RETRY_INPUT_INVALID/);
  assert.doesNotMatch(result.stdout, /Clone stage: config/);
  const [attempt] = await readdir(join(root, 'artifacts'));
  assert.equal(
    JSON.parse(
      await readFile(
        join(root, 'artifacts', attempt, 'run-result.json'),
        'utf8',
      ),
    ).destinationResetStarted,
    false,
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'retry-cli-'));
  for (const name of ['scripts', 'src'])
    await cp(join(repo, name), join(root, name), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  return root;
}
function invoke(root: string, args: string[], cwd = root) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(
        new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url),
      ),
      join(root, 'scripts/clone-retry.ts'),
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, TMPDIR: root } },
  );
}
