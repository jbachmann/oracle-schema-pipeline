import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { readPassword } from '../src/password.js';

class Terminal extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

function setup(t: TestContext) {
  const input = new Terminal();
  const output: string[] = [];
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const originalPassword = process.env.ORACLE_PASSWORD;
  delete process.env.ORACLE_PASSWORD;
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  t.after(() => {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (originalPassword === undefined) delete process.env.ORACLE_PASSWORD;
    else process.env.ORACLE_PASSWORD = originalPassword;
    input.destroy();
  });
  return {
    input,
    output,
    prompt: () => readPassword((text) => output.push(text)),
  };
}

function assertClean(input: Terminal, wasRawMode = false, wasFlowing = false) {
  assert.equal(input.isRaw, wasRawMode);
  assert.equal(input.readableFlowing, wasFlowing);
  for (const event of ['data', 'error', 'end']) {
    assert.equal(input.listenerCount(event), 0);
  }
}

test('environment password takes precedence without touching the terminal', async (t) => {
  const { input, output, prompt } = setup(t);
  input.isTTY = false;
  const password = randomUUID();
  process.env.ORACLE_PASSWORD = password;
  assert.equal(await prompt(), password);
  assert.deepEqual(output, []);
  assert.equal(input.readableFlowing, null);
});

test('non-interactive input rejects without a prompt', async (t) => {
  const { input, output, prompt } = setup(t);
  input.isTTY = false;
  await assert.rejects(prompt(), /Set ORACLE_PASSWORD/);
  assert.deepEqual(output, []);
});

for (const enter of ['\r', '\n', '\r\n']) {
  test(`Enter ${JSON.stringify(enter)} accepts hidden input across chunks`, async (t) => {
    const { input, output, prompt } = setup(t);
    const password = randomUUID();
    const pending = prompt();
    assert.equal(input.isRaw, true);
    input.emit('data', password.slice(0, 8));
    input.emit('data', password.slice(8) + enter + 'ignored');
    assert.equal(await pending, password);
    assert.deepEqual(output, ['Source password: ', '\n']);
    assertClean(input);
  });
}

test('backspace handles empty input and removes a whole Unicode code point', async (t) => {
  const { input, prompt } = setup(t);
  const password = randomUUID();
  const pending = prompt();
  input.emit('data', '\b\u007f' + password + '😀\u007fx\b\t\n');
  assert.equal(await pending, password);
  assertClean(input);
});

test('an empty environment value falls back to a prompt that accepts empty input', async (t) => {
  const { input, prompt } = setup(t);
  process.env.ORACLE_PASSWORD = '';
  const pending = prompt();
  input.emit('data', '\n');
  assert.equal(await pending, '');
  assertClean(input);
});

for (const cancel of ['\u0003', '\u0004', 'end']) {
  test(`cancellation ${JSON.stringify(cancel)} restores the terminal`, async (t) => {
    const { input, output, prompt } = setup(t);
    const pending = prompt();
    if (cancel === 'end') input.emit('end');
    else input.emit('data', cancel);
    await assert.rejects(pending, /Password entry cancelled/);
    assert.deepEqual(output, ['Source password: ', '\n']);
    assertClean(input);
  });
}

test('input errors reject with the original error and clean up', async (t) => {
  const { input, prompt } = setup(t);
  const error = new Error('Input failed');
  const pending = prompt();
  input.emit('error', error);
  await assert.rejects(pending, (actual) => actual === error);
  assertClean(input);
});

test('existing raw mode and flowing input are preserved', async (t) => {
  const { input, prompt } = setup(t);
  input.setRawMode(true);
  input.resume();
  const pending = prompt();
  input.emit('data', '\n');
  await pending;
  assertClean(input, true, true);
});

test('setup failures restore terminal state', async (t) => {
  const { input, output, prompt } = setup(t);
  const error = new Error('Encoding setup failed');
  t.mock.method(input, 'setEncoding', () => {
    throw error;
  });
  await assert.rejects(prompt(), (actual) => actual === error);
  assert.deepEqual(output, ['Source password: ', '\n']);
  assertClean(input);
});

test('raw-mode restoration failure still pauses input and finishes output', async (t) => {
  const { input, output, prompt } = setup(t);
  const pending = prompt();
  const error = new Error('Restoration failed');
  t.mock.method(input, 'setRawMode', () => {
    throw error;
  });
  input.emit('data', '\n');
  await assert.rejects(pending, (actual) => actual === error);
  assert.deepEqual(output, ['Source password: ', '\n']);
  assertClean(input, true);
});

test('cleanup failure preserves the original input error', async (t) => {
  const { input, prompt } = setup(t);
  const pending = prompt();
  const error = new Error('Input failed');
  t.mock.method(input, 'setRawMode', () => {
    throw new Error('Restoration failed');
  });
  input.emit('error', error);
  await assert.rejects(pending, (actual) => actual === error);
  assertClean(input, true);
});

test('newline output failure rejects after restoring the terminal', async (t) => {
  const { input } = setup(t);
  const error = new Error('Output failed');
  const pending = readPassword((text) => {
    if (text === '\n') throw error;
  });
  input.emit('data', '\n');
  await assert.rejects(pending, (actual) => actual === error);
  assertClean(input);
});

test('prompt output failure leaves the terminal untouched', async (t) => {
  const { input } = setup(t);
  const error = new Error('Output failed');
  await assert.rejects(
    readPassword(() => {
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(input.isRaw, false);
  assert.equal(input.readableFlowing, null);
  assert.equal(input.listenerCount('data'), 0);
});

test('the CLI can suppress all prompt output', async (t) => {
  const { input } = setup(t);
  const writes = t.mock.method(process.stderr, 'write', () => true);
  const pending = readPassword(() => {});
  input.emit('data', '\n');
  await pending;
  assert.equal(writes.mock.callCount(), 0);
  assertClean(input);
});
