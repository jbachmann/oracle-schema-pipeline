import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishArtifacts, jsonBytes } from '../src/files.js';
import { verifyCompletion } from '../src/completion.js';

for (const failure of [
  'missing-manifest',
  'version',
  'role',
  'path',
  'length',
  'hash',
  'missing-artifact',
  'count',
]) {
  test(`completion consumer rejects ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'completion-consumer-'));
    try {
      const path = join(directory, 'target');
      const completion = join(directory, 'complete');
      const expected = [{ role: 'target', path }];
      await publishArtifacts(
        [{ ...expected[0], contents: jsonBytes({ ok: true }) }],
        completion,
        { tempDir: directory },
      );
      await verifyCompletion(completion, expected);
      const manifest = JSON.parse(await readFile(completion, 'utf8'));
      if (failure === 'missing-manifest') await rm(completion);
      else if (failure === 'missing-artifact') await rm(path);
      else {
        if (failure === 'version') manifest.version = 2;
        if (failure === 'role') manifest.artifacts[0].role = 'report';
        if (failure === 'path')
          manifest.artifacts[0].path = join(directory, 'untrusted');
        if (failure === 'length') manifest.artifacts[0].bytes++;
        if (failure === 'hash') manifest.artifacts[0].sha256 = '0'.repeat(64);
        if (failure === 'count') manifest.artifacts = [];
        await writeFile(completion, jsonBytes(manifest));
      }
      await assert.rejects(verifyCompletion(completion, expected), {
        code: 'OUTPUT_INCOMPLETE',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
