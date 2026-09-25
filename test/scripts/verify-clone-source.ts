import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import oracle, { type Connection } from 'oracledb';
import { childEnvironment, runProcess } from '../../scripts/process.js';
import { testComposeArgs, rejectDsnOverrides } from './compose.js';
import { waitForListener } from './readiness.js';
import { assertIndependentFacts } from '../integration/independent-facts.js';

// Explicit opt-in: creates the seeded test source and the operational clone
// destination. Requires both named volumes to be absent; leaves evidence and
// databases available for inspection. Never reads config/local from the repo.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const owners = ['IAM', 'CATALOG', 'COMMERCE', 'FINANCE'];
const ownerList = owners.map((owner) => `'${owner}'`).join(',');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sourcePassword = `S${randomUUID().replaceAll('-', '')}`;
const destinationPassword = `D${randomUUID().replaceAll('-', '')}`;
const env = {
  ...childEnvironment(),
  ORACLE_PWD: sourcePassword,
  ORACLE_SOURCE_PORT: '1538',
  ORACLE_SOURCE_EM_PORT: '5538',
};
const docker = (args: string[]) =>
  runProcess('docker', args, { env, timeoutMs: 1_300_000 });
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = (value: unknown) =>
  createHash('sha256').update(json(value)).digest('hex');
const rows = async (connection: Connection, sql: string, binds = {}) =>
  (
    await connection.execute<unknown[]>(sql, binds, {
      outFormat: oracle.OUT_FORMAT_ARRAY,
    })
  ).rows!;

oracle.fetchAsString = [oracle.CLOB];
oracle.fetchAsBuffer = [oracle.BLOB];

export async function snapshot(connection: Connection) {
  const facts: Record<string, unknown> = {};
  // Stable metadata, including object identities/timestamps, detects DDL even
  // when an object is dropped and recreated with an identical definition.
  const queries = {
    objects: `SELECT owner,object_name,subobject_name,object_id,data_object_id,object_type,created,last_ddl_time,status FROM dba_objects WHERE owner IN (${ownerList})`,
    columns: `SELECT owner,table_name,column_name,column_id,data_type,data_type_owner,data_length,data_precision,data_scale,nullable,data_default,char_length,char_used,virtual_column,identity_column FROM dba_tab_cols WHERE owner IN (${ownerList})`,
    constraints: `SELECT owner,constraint_name,constraint_type,table_name,search_condition,r_owner,r_constraint_name,delete_rule,status,deferrable,deferred,validated,generated FROM dba_constraints WHERE owner IN (${ownerList})`,
    constraintColumns: `SELECT owner,constraint_name,table_name,column_name,position FROM dba_cons_columns WHERE owner IN (${ownerList})`,
    indexes: `SELECT owner,index_name,index_type,table_owner,table_name,uniqueness,status,visibility,compression FROM dba_indexes WHERE owner IN (${ownerList})`,
    indexColumns: `SELECT index_owner,index_name,table_owner,table_name,column_name,column_position,descend FROM dba_ind_columns WHERE index_owner IN (${ownerList})`,
    indexExpressions: `SELECT index_owner,index_name,column_position,column_expression FROM dba_ind_expressions WHERE index_owner IN (${ownerList})`,
    sequences: `SELECT sequence_owner,sequence_name,min_value,max_value,increment_by,cycle_flag,order_flag,cache_size,last_number FROM dba_sequences WHERE sequence_owner IN (${ownerList})`,
    views: `SELECT owner,view_name,text,read_only,bequeath FROM dba_views WHERE owner IN (${ownerList})`,
    tableComments: `SELECT owner,table_name,comments FROM dba_tab_comments WHERE owner IN (${ownerList})`,
    columnComments: `SELECT owner,table_name,column_name,comments FROM dba_col_comments WHERE owner IN (${ownerList})`,
    grants: `SELECT grantee,owner,table_name,grantor,privilege,grantable,hierarchy FROM dba_tab_privs WHERE owner IN (${ownerList}) OR grantee IN (${ownerList})`,
    users: `SELECT username,user_id,account_status,default_tablespace,temporary_tablespace,created,profile,authentication_type FROM dba_users WHERE oracle_maintained='N'`,
    systemGrants: `SELECT grantee,privilege,admin_option FROM dba_sys_privs WHERE grantee IN (${ownerList},'SCHEMA_READER','LIMITED_READER')`,
    roleGrants: `SELECT grantee,granted_role,admin_option,default_role FROM dba_role_privs WHERE grantee IN (${ownerList},'SCHEMA_READER','LIMITED_READER')`,
    triggers: `SELECT owner,trigger_name,trigger_type,triggering_event,table_owner,table_name,status,trigger_body FROM dba_triggers WHERE owner IN (${ownerList})`,
  };
  for (const [name, sql] of Object.entries(queries))
    facts[name] = (await rows(connection, sql))
      .map((row) => JSON.stringify(row))
      .sort();
  const tables = await rows(
    connection,
    `SELECT owner,table_name FROM dba_tables WHERE owner IN (${ownerList}) ORDER BY owner,table_name`,
  );
  const data: Record<string, string[]> = {};
  for (const [owner, table] of tables) {
    data[`${owner}.${table}`] = (
      await rows(
        connection,
        `SELECT t.* FROM ${quote(String(owner))}.${quote(String(table))} t`,
      )
    )
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return { facts, data };
}

async function main() {
  assert.equal(
    process.env.VERIFY_CLONE_SOURCE,
    '1',
    'Set VERIFY_CLONE_SOURCE=1',
  );
  rejectDsnOverrides();
  const volumes = (await docker(['volume', 'ls', '-q'])).split('\n');
  for (const name of [
    'oracle-schema-pipeline-test_oracle-source-data',
    'oracle-schema-pipeline-local_oracle-destination-data',
  ])
    assert.ok(!volumes.includes(name), `Refusing pre-existing volume ${name}`);
  for (const project of [
    'oracle-schema-pipeline-test',
    'oracle-schema-pipeline-local',
  ])
    assert.equal(
      (
        await docker([
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ])
      ).trim(),
      '',
      `Refusing existing ${project} containers`,
    );
  await mkdir(join(repo, 'artifacts'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(repo, 'artifacts/source-safety-'));
  console.log(`Evidence: ${directory}`);
  const root = await mkdtemp(join(tmpdir(), 'clone-source-safety-'));
  console.log(`Isolated runtime workspace: ${root}`);
  for (const name of ['src', 'scripts', 'package.json', 'docker-compose.yml'])
    await cp(join(repo, name), join(root, name), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  await mkdir(join(root, 'config/local'), { recursive: true, mode: 0o700 });
  // Private runtime config contains generated test secrets, never source secrets.
  await writeFile(
    join(root, 'config/local/config.json'),
    json({
      version: 1,
      source: {
        user: 'SYSTEM',
        password: sourcePassword,
        dsn: '127.0.0.1:1538/FREEPDB1',
        catalogScope: 'dba',
      },
      destination: {
        password: destinationPassword,
        port: 1539,
        startupTimeoutSeconds: 1200,
      },
    }),
    { mode: 0o600 },
  );
  console.log('Starting clean seeded Docker source (98 tables, 5 views).');
  await docker([
    ...testComposeArgs,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '1200',
    'oracle-source',
  ]);
  await waitForListener('127.0.0.1:1538/FREEPDB1', sourcePassword);
  const source = await oracle.getConnection({
    user: 'SYSTEM',
    password: sourcePassword,
    connectString: '127.0.0.1:1538/FREEPDB1',
  });
  try {
    // A listener can accept connections while startup SQL is still running.
    // Verify the seed completion marker directly before inserting any rows.
    const seedDeadline = Date.now() + 600_000;
    while (true) {
      const ready = await rows(
        source,
        `SELECT COUNT(*) FROM dba_sequences WHERE sequence_owner='IAM' AND sequence_name='SOURCE_SEED_COMPLETE'`,
      );
      if (ready[0][0] === 1) break;
      assert.ok(Date.now() < seedDeadline, 'Source seed readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    console.log(
      'Seed completion confirmed through the source listener. Adding representative rows.',
    );
    // Representative committed data, with identity, FK, Unicode, NULL, CLOB,
    // and defaults. Seed writes end before the baseline.
    for (const sql of [
      `INSERT INTO IAM.organizations (org_code,legal_name) VALUES ('SAFETY','Clone safety — Ω')`,
      `INSERT INTO IAM.principals (organization_id,username,email) SELECT organization_id,'alice','alice@example.invalid' FROM IAM.organizations WHERE org_code='SAFETY'`,
      `INSERT INTO IAM.user_profiles (principal_id,display_name,profile_json) SELECT principal_id,'Alice Ω','{"nested":{"value":42},"text":"source must stay intact"}' FROM IAM.principals WHERE username='alice'`,
      `INSERT INTO IAM.permissions (permission_key,resource_type,action_name) VALUES ('safety.read','fixture','read')`,
      `INSERT INTO CATALOG.products (organization_id,sku,product_name,description,lifecycle_status) SELECT organization_id,'SAFETY-1','Representative product','Unicode Ω and apostrophe''s CLOB','ACTIVE' FROM IAM.organizations WHERE org_code='SAFETY'`,
      `INSERT INTO COMMERCE.customers (organization_id,customer_number,customer_type,display_name) SELECT organization_id,'SAFETY-C1','PERSON','Alice' FROM IAM.organizations WHERE org_code='SAFETY'`,
      `INSERT INTO FINANCE.currencies VALUES ('USD','US Dollar',2)`,
      `INSERT INTO FINANCE.currencies VALUES ('EUR','Euro',2)`,
    ])
      await source.execute(sql);
    await source.commit();
    await assertIndependentFacts('127.0.0.1:1538/FREEPDB1', sourcePassword);
    const tables = await rows(
      source,
      `SELECT owner,table_name FROM dba_tables WHERE owner IN (${ownerList}) ORDER BY owner,table_name`,
    );
    const views = await rows(
      source,
      `SELECT owner,view_name FROM dba_views WHERE owner IN (${ownerList}) ORDER BY owner,view_name`,
    );
    assert.equal(tables.length, 98);
    assert.equal(views.length, 5);
    await writeFile(
      join(root, 'config/local/objects.json'),
      json({
        version: 2,
        tables: tables.map(([owner, name]) => ({ owner, name })),
        views: views.map(([owner, name]) => ({ owner, name })),
      }),
    );
    await writeFile(join(root, 'config/local/policy.json'), '{}\n');
    const before = await snapshot(source);
    await writeFile(join(directory, 'source-before.json'), json(before));
    const sourceIdBefore = (
      await docker([
        'ps',
        '-q',
        '--filter',
        'name=^/oracle-schema-pipeline-test-oracle-source-1$',
      ])
    ).trim();
    assert.ok(sourceIdBefore);
    console.log(
      'Baseline captured. Running npm run db:clone in isolated copy of current code.',
    );
    let cloneError: unknown;
    try {
      const output = await runProcess('npm', ['run', 'db:clone'], {
        cwd: root,
        env: childEnvironment(),
        timeoutMs: 1_800_000,
      });
      console.log(output.trim());
      await writeFile(join(directory, 'clone.log'), output);
    } catch (error) {
      cloneError = error;
    }
    // Capture preservation evidence even when the clone fails.
    const after = await snapshot(source);
    await writeFile(join(directory, 'source-after.json'), json(after));
    assert.deepEqual(after, before, 'Source metadata or data changed');
    assert.equal(
      (
        await docker([
          'ps',
          '-q',
          '--filter',
          'name=^/oracle-schema-pipeline-test-oracle-source-1$',
        ])
      ).trim(),
      sourceIdBefore,
    );
    console.log('Source before/after snapshots are identical.');
    if (cloneError) throw cloneError;
    const runs = (await readdir(join(root, 'artifacts'))).filter((name) =>
      name.startsWith('db-clone-'),
    );
    assert.equal(runs.length, 1);
    const runResult = JSON.parse(
      await readFile(
        join(root, 'artifacts', runs[0], 'run-result.json'),
        'utf8',
      ),
    );
    assert.equal(runResult.status, 'succeeded');
    await waitForListener('127.0.0.1:1539/FREEPDB1', destinationPassword);
    await assertIndependentFacts(
      '127.0.0.1:1539/FREEPDB1',
      destinationPassword,
    );
    const destination = await oracle.getConnection({
      user: 'SYSTEM',
      password: destinationPassword,
      connectString: '127.0.0.1:1539/FREEPDB1',
    });
    let destinationFacts;
    try {
      destinationFacts = await snapshot(destination);
      assert.deepEqual(
        Object.keys(destinationFacts.data),
        Object.keys(before.data),
      );
      assert.ok(
        Object.values(destinationFacts.data).every(
          (table) => table.length === 0,
        ),
      );
      assert.deepEqual(
        await rows(
          destination,
          `SELECT owner,view_name FROM dba_views WHERE owner IN (${ownerList}) ORDER BY owner,view_name`,
        ),
        views,
      );
      const target = JSON.parse(
        await readFile(join(root, 'artifacts', runs[0], 'target.json'), 'utf8'),
      );
      for (const table of target.tables) {
        for (const index of table.indexes) {
          assert.deepEqual(
            await rows(
              destination,
              `SELECT status FROM dba_indexes WHERE owner=:owner AND index_name=:name`,
              index.reference,
            ),
            [['VALID']],
          );
        }
      }
    } finally {
      await destination.close();
    }
    await writeFile(
      join(directory, 'destination.json'),
      json(destinationFacts),
    );
    const report = {
      status: 'passed',
      command: 'npm run db:clone',
      testedAt: new Date().toISOString(),
      runtimeWorkspace: root,
      source: {
        tables: tables.length,
        views: views.length,
        rows: Object.values(before.data).reduce(
          (n, table) => n + table.length,
          0,
        ),
        beforeSha256: digest(before),
        afterSha256: digest(after),
        unchanged: true,
        containerId: sourceIdBefore,
      },
      destination: {
        tables: Object.keys(destinationFacts.data).length,
        views: views.length,
        rows: 0,
        independentSeedFactsPassed: true,
        runResult,
      },
      comparedMetadata: Object.keys(before.facts),
      scope:
        'Fixture schema definitions, object IDs and DDL timestamps, all table rows, grants, users, sequence state. Excludes Oracle audit/operational statistics and internal background activity.',
    };
    await writeFile(join(directory, 'verification.json'), json(report));
    console.log(json(report));
  } finally {
    await source.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // Avoid forwarding driver/config errors that could contain credentials.
    console.error(
      `Verification failed: ${error instanceof assert.AssertionError ? error.message : ((error as { code?: string }).code ?? 'DATABASE_OR_PROCESS_ERROR')}`,
    );
    process.exitCode = 1;
  });
