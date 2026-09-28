import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProcess,
  childEnvironment,
  CloneError,
} from '../scripts/process.js';

test('subprocess failure exposes only fixed code and exit status', async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', "console.error('private-secret'); process.exit(7)"],
      { env: childEnvironment() },
    ),
    (error) => {
      assert.ok(error instanceof CloneError);
      assert.equal(error.childExitCode, 7);
      assert.equal(error.message, 'CLONE_STAGE_FAILED');
      return true;
    },
  );
});
test('active child termination becomes interruption, never success', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: childEnvironment(),
        signal: controller.signal,
      }),
      /CLONE_INTERRUPTED/,
    );
  } finally {
    clearTimeout(timer);
  }
});
test('bounded subprocess timeout stops dependent work', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: childEnvironment(),
      timeoutMs: 100,
    }),
    /CLONE_STAGE_FAILED/,
  );
});

test('ambient Oracle, Compose, and Node overrides never enter child environments', () => {
  const overrides = {
    ORACLE_PASSWORD: 'ambient-source-secret',
    ORACLE_SOURCE_DSN: 'other-source',
    COMPOSE_FILE: '/other-compose.yml',
    COMPOSE_PROJECT_NAME: 'other-project',
    COMPOSE_ENV_FILES: '/other.env',
    NODE_OPTIONS: '--trace-warnings',
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, overrides);
    const env = childEnvironment();
    for (const key of Object.keys(overrides)) assert.equal(env[key], undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('progress frames both streams across chunks, CR/LF, and final records without changing stdout or legacy stderr', async () => {
  const records: { stream: string; line: string }[] = [],
    legacy: string[] = [];
  const stdout = await runProcess(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('one\\r');
    process.stderr.write('err\\n');
    setTimeout(() => { process.stdout.write('\\ntw'); process.stderr.write('tail'); }, 10);
    setTimeout(() => process.stdout.write('o\\nfinal'), 20);
  `,
    ],
    {
      env: childEnvironment(),
      onProgressLine: (record) => records.push(record),
      onLine: (line) => legacy.push(line),
    },
  );
  assert.equal(stdout, 'one\r\ntwo\nfinal');
  assert.deepEqual(
    records
      .filter((record) => record.stream === 'stdout')
      .map((record) => record.line),
    ['one', 'two', 'final'],
  );
  assert.deepEqual(
    records
      .filter((record) => record.stream === 'stderr')
      .map((record) => record.line),
    ['err', 'tail'],
  );
  assert.deepEqual(legacy, ['err']);
});
test('oversized progress records discard their later tails and observers cannot fail a child', async () => {
  const lines: string[] = [];
  await runProcess(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('x'.repeat(64001));
    setTimeout(() => process.stdout.write('abcdef123456: Waiting\\nvalid\\nfinal'), 10);
  `,
    ],
    {
      env: childEnvironment(),
      onProgressLine: ({ line }) => {
        lines.push(line);
        throw Error('observer');
      },
    },
  );
  assert.deepEqual(lines, ['valid', 'final']);
});
for (const mode of ['timeout', 'abort'] as const) {
  test(`progress stops when child settles after ${mode}`, async () => {
    const controller = new AbortController(),
      lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    await assert.rejects(
      runProcess(
        process.execPath,
        [
          '-e',
          "process.stdout.write('ready\\n'); setInterval(() => process.stdout.write('tick\\r'), 5)",
        ],
        {
          env: childEnvironment(),
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 250 : 2000,
          onProgressLine: ({ line }) => {
            lines.push(line);
            if (mode === 'abort' && line === 'ready')
              timer = setTimeout(() => controller.abort(), 20);
          },
        },
      ),
      mode === 'abort' ? /CLONE_INTERRUPTED/ : /CLONE_STAGE_FAILED/,
    );
    clearTimeout(timer);
    assert.ok(lines.length > 0);
    const count = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lines.length, count);
  });
}
