import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  constants,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConnectionOptions } from '../src/connection.js';

test('raw DSN is passed through byte-for-byte', async () => {
  const dsn = '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521)))';
  assert.deepEqual(await resolveConnectionOptions({ dsn }, async () => []), {
    connectString: dsn,
  });
});

test('TNS file resolves alias case-insensitively and supplies configDir', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-tns-'));
  const path = join(directory, 'tnsnames.ora');
  await writeFile(path, 'SALES=(DESCRIPTION=...)');
  assert.deepEqual(
    await resolveConnectionOptions(
      { tnsnames: path, tnsAlias: 'sales' },
      async (configDir) => {
        assert.equal(configDir, directory);
        return ['SALES'];
      },
    ),
    { connectString: 'sales', configDir: directory },
  );
});

test('connection option conflicts and incomplete pairs fail', async () => {
  const aliases = async () => [] as string[];
  await assert.rejects(
    resolveConnectionOptions({}, aliases),
    /Missing --dsn or/,
  );
  await assert.rejects(
    resolveConnectionOptions({ dsn: 'db', tnsAlias: 'X' }, aliases),
    /mutually exclusive/,
  );
  await assert.rejects(
    resolveConnectionOptions({ tnsAlias: 'X' }, aliases),
    /Missing --tnsnames/,
  );
  await assert.rejects(
    resolveConnectionOptions({ tnsnames: '/tmp/tnsnames.ora' }, aliases),
    /Missing --tns-alias/,
  );
});

test('missing TNS file fails before listing aliases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-tns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'tnsnames.ora');
  let aliasesCalled = false;

  await assert.rejects(
    resolveConnectionOptions({ tnsnames: path, tnsAlias: 'X' }, async () => {
      aliasesCalled = true;
      return ['X'];
    }),
    {
      message: `TNS file is missing, unreadable, or not a regular file: ${path}.`,
    },
  );
  assert.equal(aliasesCalled, false);
});

test('unreadable TNS file fails before listing aliases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-tns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'tnsnames.ora');
  await writeFile(path, 'X=...');

  try {
    await chmod(path, 0o000);
    const readable = await access(path, constants.R_OK).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
          throw error;
        }
        return false;
      },
    );
    if (readable) {
      t.skip('Process can read the file despite removed read permissions.');
      return;
    }

    let aliasesCalled = false;
    await assert.rejects(
      resolveConnectionOptions({ tnsnames: path, tnsAlias: 'X' }, async () => {
        aliasesCalled = true;
        return ['X'];
      }),
      {
        message: `TNS file is missing, unreadable, or not a regular file: ${path}.`,
      },
    );
    assert.equal(aliasesCalled, false);
  } finally {
    await chmod(path, 0o600);
  }
});

test('alias loader failure reports the TNS path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-tns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'tnsnames.ora');
  await writeFile(path, 'X=...');

  await assert.rejects(
    resolveConnectionOptions({ tnsnames: path, tnsAlias: 'X' }, async () => {
      throw new Error('Alias loader failed');
    }),
    { message: `Unable to read TNS aliases from ${path}.` },
  );
});

test('TNS path and alias failures are actionable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-tns-'));
  const wrong = join(directory, 'network.ora');
  await writeFile(wrong, 'X=...');
  await assert.rejects(
    resolveConnectionOptions(
      { tnsnames: 'tnsnames.ora', tnsAlias: 'X' },
      async () => [],
    ),
    /must be absolute/,
  );
  await assert.rejects(
    resolveConnectionOptions(
      { tnsnames: wrong, tnsAlias: 'X' },
      async () => [],
    ),
    /must be named/,
  );
  const folder = join(directory, 'tnsnames.ora');
  await mkdir(folder);
  await assert.rejects(
    resolveConnectionOptions(
      { tnsnames: folder, tnsAlias: 'X' },
      async () => [],
    ),
    /not a regular file/,
  );
  const valid = join(
    await mkdtemp(join(tmpdir(), 'oracle-tns-')),
    'tnsnames.ora',
  );
  await writeFile(valid, 'KNOWN=...');
  await assert.rejects(
    resolveConnectionOptions(
      { tnsnames: valid, tnsAlias: 'SECRET' },
      async () => ['KNOWN'],
    ),
    /TNS alias SECRET not found/,
  );
});
