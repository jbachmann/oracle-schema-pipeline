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
