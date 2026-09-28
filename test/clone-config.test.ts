import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneConfigSchema, loadCloneConfig } from '../scripts/clone-config.js';
const config = () => ({
  version: 1,
  source: {
    user: 'APP',
    password: 'literal$"`\\secret',
    dsn: 'localhost:1521/FREEPDB1',
  },
  destination: { password: 'different-secret' },
});
test('configuration defaults, literal secrets, and mutually exclusive source connections', () => {
  const input = config();
  const parsed = cloneConfigSchema.parse(input);
  assert.equal(parsed.source.password, input.source.password);
  assert.equal(parsed.destination.port, 1522);
  assert.equal(parsed.source.catalogScope, 'all');
  assert.ok(
    cloneConfigSchema.safeParse({
      ...input,
      source: {
        user: 'APP',
        password: 'secret',
        tnsnames: './tnsnames.ora',
        tnsAlias: 'REMOTE',
      },
    }).success,
  );
  for (const source of [
    { ...input.source, tnsAlias: 'ALIAS' },
    { ...input.source, dsn: undefined },
    { ...input.source, dsn: 'user/password@host' },
  ])
    assert.equal(
      cloneConfigSchema.safeParse({ ...input, source }).success,
      false,
    );
});
test('configuration accepts the same source and destination password', () => {
  const input = config();
  input.destination.password = input.source.password;
  const parsed = cloneConfigSchema.parse(input);
  assert.equal(parsed.source.password, input.source.password);
  assert.equal(parsed.destination.password, input.source.password);
});
test('configuration rejects unknown fields, placeholders, missing secrets and invalid versions/ports', () => {
  const input = config();
  for (const value of [
    { ...input, version: 2 },
    { ...input, extra: true },
    ...[
      { dsn: 'remote' },
      { composeFile: 'other' },
      { password: 'REPLACE_DESTINATION_PASSWORD' },
      { password: '' },
      { port: 0 },
      { port: 65536 },
    ].map((change) => ({
      ...input,
      destination: { ...input.destination, ...change },
    })),
  ])
    assert.equal(cloneConfigSchema.safeParse(value).success, false);
});
test('loader resolves adjacent files and keeps secret values out of diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clone-config-'));
  await mkdir(join(root, 'files'));
  await writeFile(
    join(root, 'files/objects.json'),
    JSON.stringify({
      version: 2,
      tables: [{ owner: 'APP', name: 'T' }],
      views: [],
    }),
  );
  await writeFile(join(root, 'policy.json'), '{}');
  const input = { ...config(), objects: 'files/objects.json' };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(input));
  assert.equal((await loadCloneConfig(path)).objects.tables[0].name, 'T');
  await writeFile(join(root, 'policy.json'), '{"createSchemas":false}');
  await assert.rejects(loadCloneConfig(path), /CLONE_PREREQUISITE_REQUIRED/);
  await writeFile(
    path,
    JSON.stringify({ ...input, source: { ...input.source, password: '' } }),
  );
  await assert.rejects(loadCloneConfig(path), (error) => {
    assert.equal(String(error), 'Error: CLONE_CONFIG_INVALID');
    return true;
  });
});

test('relative TNS configuration is resolved and incomplete aliases are rejected safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clone-tns-'));
  await writeFile(
    join(root, 'tnsnames.ora'),
    'REMOTE = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=example)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1)))',
  );
  await writeFile(
    join(root, 'objects.json'),
    JSON.stringify({
      version: 2,
      tables: [{ owner: 'APP', name: 'T' }],
      views: [],
    }),
  );
  await writeFile(join(root, 'policy.json'), '{}');
  const input = {
    ...config(),
    source: {
      user: 'APP',
      password: 'source-secret',
      tnsnames: 'tnsnames.ora',
      tnsAlias: 'REMOTE',
    },
  };
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(input));
  assert.equal(
    (await loadCloneConfig(path)).config.source.tnsnames,
    join(root, 'tnsnames.ora'),
  );
  await writeFile(
    path,
    JSON.stringify({
      ...input,
      source: { ...input.source, tnsAlias: 'MISSING' },
    }),
  );
  await assert.rejects(loadCloneConfig(path), /CLONE_CONFIG_INVALID/);
});
test('prerequisite bytes are retained and common session-changing commands are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clone-setup-'));
  await writeFile(
    join(root, 'objects.json'),
    JSON.stringify({
      version: 2,
      tables: [{ owner: 'APP', name: 'T' }],
      views: [],
    }),
  );
  await writeFile(join(root, 'policy.json'), '{"createSchemas":false}');
  const path = join(root, 'config.json');
  await writeFile(
    path,
    JSON.stringify({ ...config(), prerequisiteSql: 'setup.sql' }),
  );
  await writeFile(
    join(root, 'setup.sql'),
    'CREATE USER APP NO AUTHENTICATION;',
  );
  assert.equal(
    (await loadCloneConfig(path)).prerequisite?.toString(),
    'CREATE USER APP NO AUTHENTICATION;',
  );
  for (const sql of [
    'CONNECT other',
    '@other.sql',
    'HOST command',
    'EXIT SUCCESS',
    'WHENEVER SQLERROR CONTINUE',
    'SET ECHO ON',
    'ALTER SESSION SET CONTAINER=CDB$ROOT;',
  ]) {
    await writeFile(join(root, 'setup.sql'), sql);
    await assert.rejects(loadCloneConfig(path), /CLONE_CONFIG_INVALID/);
  }
});

test('trusted prerequisite SQL permits sequence START WITH and PL/SQL loop EXIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clone-plsql-'));
  await writeFile(
    join(root, 'objects.json'),
    JSON.stringify({
      version: 2,
      tables: [{ owner: 'APP', name: 'T' }],
      views: [],
    }),
  );
  await writeFile(join(root, 'policy.json'), '{}');
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ ...config(), prerequisiteSql: 'setup.sql' }),
  );
  const sql =
    'CREATE SEQUENCE APP.SEQ\nSTART WITH 100;\nBEGIN\nLOOP\nEXIT;\nEND LOOP;\nEND;\n/';
  await writeFile(join(root, 'setup.sql'), sql);
  assert.equal(
    (await loadCloneConfig(join(root, 'config.json'))).prerequisite?.toString(),
    sql,
  );
});

test('retry ignores source and selection settings, validates destination, and uses saved policy for current prerequisites', async () => {
  const { loadRetryConfig } = await import('../scripts/clone-config.js');
  const { policySchema } = await import('../src/model.js');
  const root = await mkdtemp(join(tmpdir(), 'retry-config-'));
  const path = join(root, 'config.json');
  const minimal = { version: 1, destination: config().destination };
  for (const extra of [
    {},
    { source: null, objects: 123, policy: false },
    {
      source: { tnsnames: 'missing.ora', password: '' },
      objects: 'missing',
      policy: 'missing',
    },
  ]) {
    await writeFile(path, JSON.stringify({ ...minimal, ...extra }));
    const loaded = await loadRetryConfig(path, policySchema.parse({}));
    assert.equal(loaded.config.destination.port, 1522);
    assert.equal('source' in loaded.config, false);
    await assert.rejects(loadCloneConfig(path), /CLONE_CONFIG_INVALID/);
    await assert.rejects(
      loadRetryConfig(path, policySchema.parse({ createSchemas: false })),
      /CLONE_PREREQUISITE_REQUIRED/,
    );
  }
  for (const extra of [
    { surprise: true },
    { version: 2 },
    { destination: { password: 'REPLACE_PASSWORD' } },
    { destination: { ...minimal.destination, port: 0 } },
  ]) {
    await writeFile(path, JSON.stringify({ ...minimal, ...extra }));
    await assert.rejects(
      loadRetryConfig(path, policySchema.parse({})),
      /CLONE_CONFIG_INVALID/,
    );
  }
  await writeFile(
    path,
    JSON.stringify({ ...minimal, prerequisiteSql: 'setup.sql' }),
  );
  for (const sql of ['SELECT 1 FROM dual;', 'SELECT 2 FROM dual;']) {
    await writeFile(join(root, 'setup.sql'), sql);
    assert.equal(
      (
        await loadRetryConfig(
          path,
          policySchema.parse({ createSchemas: false }),
        )
      ).prerequisite?.toString(),
      sql,
    );
  }
  await writeFile(join(root, 'setup.sql'), '@unsafe.sql');
  await assert.rejects(
    loadRetryConfig(path, policySchema.parse({})),
    /CLONE_CONFIG_INVALID/,
  );
});
