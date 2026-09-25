import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function cli(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    { encoding: 'utf8' },
  );
}

test('CLI progress is disabled by default and documented in help', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /--progress-json/);
  const invalid = cli(['extract']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Missing --output/);
  assert.ok(!invalid.stderr.includes('runId'));
});

test('CLI progress errors are JSON with a run ID and exclude raw argument values', () => {
  const secret = 'password-and-private-descriptor';
  const result = cli(['--progress-json', `--${secret}`]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const event = JSON.parse(result.stderr);
  assert.equal(event.version, 1);
  assert.equal(event.stage, 'cli');
  assert.equal(event.event, 'failure');
  assert.equal(event.errorCode, 'EXTRACTION_FAILED');
  assert.equal(typeof event.runId, 'string');
  assert.ok(event.elapsedMs >= 0);
  assert.ok(!result.stderr.includes(secret));
});

test('offline commands reject extraction progress', () => {
  const result = cli(['transform', '--progress-json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).event, 'failure');
});
