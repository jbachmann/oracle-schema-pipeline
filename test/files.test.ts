import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson, writeNewFile } from '../src/files.js';

test('large Unicode JSON is preserved without DBMS_OUTPUT limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-model-'));
  try {
    const filename = join(directory, 'source.json'), document = { expression: '日本語 😀'.repeat(10000) };
    await writeJson(filename, document);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), document);
    await assert.rejects(access(filename + '.partial'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('existing artifact is never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-model-'));
  try {
    const filename = join(directory, 'source.json'); await writeNewFile(filename, 'first');
    await assert.rejects(writeNewFile(filename, 'second'), { code: 'EEXIST' });
    assert.equal(await readFile(filename, 'utf8'), 'first');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
