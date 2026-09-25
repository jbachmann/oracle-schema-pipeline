import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createArtifactWriter,
  jsonBytes,
  writeJson,
  writeNewBuffer,
  writeNewFile,
} from '../src/files.js';

test('large Unicode JSON is preserved without DBMS_OUTPUT limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-model-'));
  try {
    const filename = join(directory, 'source.json'),
      document = { expression: '日本語 😀'.repeat(10000) };
    await writeJson(filename, document);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), document);
    await assert.rejects(access(filename + '.partial'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('existing artifact is never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-model-'));
  try {
    const filename = join(directory, 'source.json');
    await writeNewFile(filename, 'first');
    await assert.rejects(writeNewFile(filename, 'second'), {
      code: 'OUTPUT_EXISTS',
    });
    assert.equal(await readFile(filename, 'utf8'), 'first');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('binary artifacts are preserved exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-model-'));
  try {
    const filename = join(directory, 'dictionary.xlsx'),
      bytes = Buffer.from([0, 255, 80, 75, 3, 4]);
    await writeNewBuffer(filename, bytes);
    assert.deepEqual(await readFile(filename), bytes);
    await assert.rejects(access(filename + '.partial'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('competing writers publish exactly one complete file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-race-'));
  try {
    const path = join(directory, 'clone.sql');
    const payloads = Array.from({ length: 8 }, (_, i) =>
      `${i} 日本語\n`.repeat(100000),
    );
    const results = await Promise.allSettled(
      payloads.map((contents) => writeNewFile(path, contents)),
    );
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    assert.equal(await readFile(path, 'utf8'), payloads[winner]);
    for (const result of results)
      if (result.status === 'rejected')
        assert.equal(result.reason.code, 'OUTPUT_EXISTS');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('staging failures never expose final contents and cleanup owns only its files', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-failure-'));
  try {
    const staging = join(directory, 'staging');
    await fs.mkdir(staging);
    await fs.writeFile(join(staging, 'stale'), 'preserve');
    const writer = createArtifactWriter({
      ...fs,
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[1] === 'wx')
          handle.sync = async () => {
            throw new Error('interrupted staging');
          };
        return handle;
      }) as typeof fs.open,
    });
    const path = join(directory, 'output');
    await assert.rejects(
      writer.publish(
        [{ role: 'sql', path, contents: Buffer.from('SQL') }],
        undefined,
        { tempDir: staging },
      ),
      /interrupted staging/,
    );
    await assert.rejects(access(path));
    assert.deepEqual(await fs.readdir(staging), ['stale']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported publication fails closed without copying', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-unsupported-'));
  try {
    const writer = createArtifactWriter({
      ...fs,
      link: async () => {
        throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
      },
    });
    const path = join(directory, 'output');
    await assert.rejects(
      writer.publish(
        [{ role: 'json', path, contents: jsonBytes({ ok: true }) }],
        undefined,
        { tempDir: directory },
      ),
      { code: 'OUTPUT_PUBLICATION_UNSUPPORTED' },
    );
    await assert.rejects(access(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup failure reports published status without failing a committed write', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-cleanup-'));
  try {
    const warnings: string[] = [];
    const writer = createArtifactWriter({
      ...fs,
      rm: async () => {
        throw new Error('cleanup');
      },
    });
    const path = join(directory, 'output');
    await writer.publish(
      [{ role: 'sql', path, contents: Buffer.from('SQL') }],
      undefined,
      { tempDir: directory, onWarning: (message) => warnings.push(message) },
    );
    assert.equal(await readFile(path, 'utf8'), 'SQL');
    assert.ok(
      warnings.some((message) => message.includes('1 file(s) published')),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preflight rejects symlink aliases and dangling output symlinks', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-alias-'));
  try {
    await fs.mkdir(join(directory, 'real'));
    await fs.symlink(join(directory, 'real'), join(directory, 'alias'));
    const writer = createArtifactWriter();
    await assert.rejects(
      writer.preflight([
        join(directory, 'real/out'),
        join(directory, 'alias/out'),
      ]),
      { code: 'OUTPUT_PATH_CONFLICT' },
    );
    const dangling = join(directory, 'dangling');
    await fs.symlink(join(directory, 'missing'), dangling);
    await assert.rejects(writer.preflight([dangling]), {
      code: 'OUTPUT_EXISTS',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cross-device staging is rejected before creating any artifact', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-device-'));
  try {
    const staging = join(directory, 'staging');
    const writer = createArtifactWriter({
      ...fs,
      stat: (async (path: string) => {
        const result = await fs.stat(path);
        return Object.assign(result, {
          dev: path.endsWith('/staging') ? 1 : 2,
        });
      }) as typeof fs.stat,
    });
    await assert.rejects(
      writer.publish(
        [
          {
            role: 'sql',
            path: join(directory, 'out'),
            contents: Buffer.from('SQL'),
          },
        ],
        undefined,
        { tempDir: staging },
      ),
      /OUTPUT_PUBLICATION_UNSUPPORTED:.*--temp-dir/,
    );
    assert.deepEqual(await fs.readdir(staging), []);
    await assert.rejects(access(join(directory, 'out')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completion manifest is last and describes exact published bytes', async () => {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const directory = await fs.realpath(
    await mkdtemp(join(tmpdir(), 'publication-bundle-')),
  );
  try {
    const completion = join(directory, 'complete.json');
    const artifacts = [
      {
        role: 'target',
        path: join(directory, 'target.json'),
        contents: jsonBytes({ value: '日本語' }),
      },
      {
        role: 'report',
        path: join(directory, 'report.json'),
        contents: jsonBytes([]),
      },
    ];
    const writer = createArtifactWriter({
      ...fs,
      link: async (from, to) => {
        await assert.rejects(access(completion));
        if (to === completion)
          for (const artifact of artifacts)
            assert.deepEqual(await readFile(artifact.path), artifact.contents);
        await fs.link(from, to);
      },
    });
    await writer.publish(artifacts, completion, { tempDir: directory });
    const manifest = JSON.parse(await readFile(completion, 'utf8'));
    assert.deepEqual(manifest, {
      version: 1,
      artifacts: artifacts.map(({ role, path, contents }) => ({
        role,
        path,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      })),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failureIndex of [0, 1, 2]) {
  test(`publication failure at bundle position ${failureIndex} leaves no completion manifest`, async () => {
    const fs = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'publication-incomplete-'));
    try {
      let calls = 0;
      const writer = createArtifactWriter({
        ...fs,
        link: async (from, to) => {
          if (calls++ === failureIndex)
            throw new Error('injected publication failure');
          await fs.link(from, to);
        },
      });
      const completion = join(directory, 'complete.json');
      const artifacts = ['target', 'report'].map((role) => ({
        role,
        path: join(directory, role),
        contents: jsonBytes({ role }),
      }));
      await assert.rejects(
        writer.publish(artifacts, completion, { tempDir: directory }),
        {
          code:
            failureIndex === 0
              ? 'OUTPUT_PUBLICATION_FAILED'
              : 'OUTPUT_INCOMPLETE',
        },
      );
      await assert.rejects(access(completion));
      for (let index = 0; index < artifacts.length; index++) {
        if (index < failureIndex)
          assert.deepEqual(
            await readFile(artifacts[index].path),
            artifacts[index].contents,
          );
        else await assert.rejects(access(artifacts[index].path));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('pre-existing report or completion prevents all bundle publication', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-existing-'));
  try {
    for (const existing of ['report', 'completion']) {
      const prefix = join(directory, existing);
      await fs.mkdir(prefix);
      await fs.writeFile(join(prefix, existing), 'original');
      await assert.rejects(
        createArtifactWriter().publish(
          ['target', 'report'].map((role) => ({
            role,
            path: join(prefix, role),
            contents: jsonBytes([]),
          })),
          join(prefix, 'completion'),
          { tempDir: directory },
        ),
        { code: 'OUTPUT_EXISTS' },
      );
      await assert.rejects(access(join(prefix, 'target')));
      assert.equal(await readFile(join(prefix, existing), 'utf8'), 'original');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('directory sync failures warn without changing bundle completion', async () => {
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'publication-sync-'));
  try {
    const warnings: string[] = [];
    const writer = createArtifactWriter({
      ...fs,
      open: (async (...args: Parameters<typeof fs.open>) => {
        if (args[1] === 'r') throw new Error('directory sync unsupported');
        return fs.open(...args);
      }) as typeof fs.open,
    });
    const completion = join(directory, 'completion');
    await writer.publish(
      [
        {
          role: 'target',
          path: join(directory, 'target'),
          contents: jsonBytes({}),
        },
      ],
      completion,
      { tempDir: directory, onWarning: (message) => warnings.push(message) },
    );
    await access(completion);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((message) => message.includes('is published')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const interruption of ['staging', 'publication']) {
  test(
    `process termination during ${interruption} leaves recoverable artifacts`,
    { timeout: 15000 },
    async () => {
      const fs = await import('node:fs/promises');
      const { spawn } = await import('node:child_process');
      const { once } = (await import('node:events')).default;
      const { resolve } = await import('node:path');
      const directory = await fs.realpath(
        await mkdtemp(join(tmpdir(), 'publication-killed-')),
      );
      const target = join(directory, 'target');
      const completion = join(directory, 'completion');
      const staging = join(directory, 'staging');
      const program = `
      import * as fs from 'node:fs/promises';
      import { createArtifactWriter } from ${JSON.stringify(new URL('../src/files.ts', import.meta.url).href)};
      const stop = async () => {
        process.stdout.write('ready');
        await new Promise(() => { setInterval(() => {}, 1000); });
      };
      const io = { ...fs };
      if (${JSON.stringify(interruption)} === 'staging') {
        io.open = async (...args) => {
          const handle = await fs.open(...args);
          if (args[1] === 'wx') handle.sync = stop;
          return handle;
        };
      } else {
        io.link = async (...args) => { await fs.link(...args); await stop(); };
      }
      await createArtifactWriter(io).publish([
        { role: 'target', path: ${JSON.stringify(target)}, contents: Buffer.from('complete target') },
        { role: 'report', path: ${JSON.stringify(join(directory, 'report'))}, contents: Buffer.from('complete report') }
      ], ${JSON.stringify(completion)}, { tempDir: ${JSON.stringify(staging)} });
    `;
      const child = spawn(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          '--input-type=module',
          '--eval',
          program,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = once(child, 'exit');
      try {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        await Promise.race([
          once(child.stdout, 'data'),
          exited.then(() => {
            throw new Error(`Child exited before interruption: ${stderr}`);
          }),
        ]);
        child.kill('SIGKILL');
        await exited;
        await assert.rejects(access(completion));
        if (interruption === 'publication')
          assert.equal(await readFile(target, 'utf8'), 'complete target');
        else await assert.rejects(access(target));
        const leftovers = await fs.readdir(staging);
        assert.equal(leftovers.length, 1);
        // A new invocation neither adopts nor deletes a killed writer's files.
        await writeNewFile(join(directory, 'retry'), 'retry bytes', {
          tempDir: staging,
        });
        assert.deepEqual(await fs.readdir(staging), leftovers);
        assert.equal(
          await readFile(join(directory, 'retry'), 'utf8'),
          'retry bytes',
        );
      } finally {
        child.kill('SIGKILL');
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test('preflight conservatively rejects case and Unicode output aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publication-case-'));
  try {
    for (const names of [
      ['Target', 'target'],
      ['caf\u00e9', 'cafe\u0301'],
    ]) {
      await assert.rejects(
        createArtifactWriter().preflight(
          names.map((name) => join(directory, name)),
        ),
        { code: 'OUTPUT_PATH_CONFLICT' },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
