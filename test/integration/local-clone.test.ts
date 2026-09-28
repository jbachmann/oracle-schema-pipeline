import { waitForListener } from '../scripts/readiness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import oracle from 'oracledb';
import {
  cloneDatabase,
  retryCloneDatabase,
} from '../../scripts/clone-workflow.js';
import {
  childEnvironment,
  runProcess,
  CloneError,
} from '../../scripts/process.js';
import {
  ComposeDestination,
  project,
  volume,
  verificationChecks,
  generatedReplay,
  setupChecks,
  sqlSession,
} from '../../scripts/compose-destination.js';
import { loadCloneConfig } from '../../scripts/clone-config.js';
import { targetDocumentSchema, policySchema } from '../../src/model.js';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';
import { generateSql } from '../../src/generate.js';
import { transformSource } from '../../src/transform.js';
import { ordinaryTable, ordinaryView, sourceFixture } from '../fixtures.js';

test(
  'conditional user creation preserves accounts and rejects role conflicts on the pinned Oracle image',
  { timeout: 1_500_000 },
  async () => {
    rejectDsnOverrides();
    if (process.env.ORACLE_INTEGRATION_USE_EXISTING !== '1') {
      await runProcess(
        'docker',
        [
          ...testComposeArgs,
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '1200',
          'oracle-destination',
        ],
        {
          env: childEnvironment(),
          timeoutMs: 1_230_000,
        },
      );
    }
    const errors: string[] = [];
    const sql = (input: string) =>
      runProcess(
        'docker',
        [
          ...testComposeArgs,
          'exec',
          '-T',
          'oracle-destination',
          'sqlplus',
          '-s',
          '/ as sysdba',
        ],
        {
          env: childEnvironment(),
          input: sqlSession(input),
          onProgressLine: ({ line }) => {
            const code = /ORA-\d{5}/.exec(line)?.[0];
            if (code) errors.push(code);
          },
        },
      );
    const targetFor = (owners: string[], createSchemas = true) => {
      const source = sourceFixture();
      source.tables = owners.map((owner) => ordinaryTable(owner, 'T'));
      source.targetTables = source.tables.map((table) => table.reference);
      return transformSource(source, policySchema.parse({ createSchemas }));
    };
    const conditional = (owner: string) =>
      generateSql(targetFor([owner])).match(/DECLARE[\s\S]*?END;\n\//)![0];
    const cleanup = `
BEGIN EXECUTE IMMEDIATE 'DROP USER SKIP_A_EXISTING CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'DROP USER SKIP_Z_NEW CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'DROP USER SKIP_VIEW CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'DROP USER SKIP_INDEX CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'DROP ROLE SKIP_ROLE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1919 THEN RAISE; END IF; END;
/`;
    await sql(cleanup);
    try {
      await sql(
        'CREATE USER SKIP_A_EXISTING NO AUTHENTICATION DEFAULT TABLESPACE SYSTEM QUOTA 1M ON USERS;\nGRANT CREATE SESSION TO SKIP_A_EXISTING;\nCREATE ROLE SKIP_ROLE;',
      );
      const facts = () =>
        sql(`SELECT username, authentication_type, default_tablespace, account_status FROM dba_users WHERE username IN ('SYS', 'SKIP_A_EXISTING') ORDER BY username;
SELECT username, tablespace_name, max_bytes FROM dba_ts_quotas WHERE username IN ('SYS', 'SKIP_A_EXISTING') ORDER BY username, tablespace_name;
SELECT grantee, privilege FROM dba_sys_privs WHERE grantee IN ('SYS', 'SKIP_A_EXISTING') ORDER BY grantee, privilege;`);
      const before = await facts();
      await sql(conditional('SYS'));
      const target = targetFor(['SKIP_A_EXISTING', 'SKIP_Z_NEW']);
      target.tables[1].indexes[0].reference.owner = 'SKIP_INDEX';
      const key = target.tables[1].constraints[0];
      if (key.kind === 'primary-key') key.backingIndex!.owner = 'SKIP_INDEX';
      const view = ordinaryView('V');
      view.reference.owner = 'SKIP_VIEW';
      target.views = [view];
      target.targetViews = [view.reference];
      await sql(
        setupChecks(target) +
          generatedReplay(generateSql(target)) +
          '\n' +
          verificationChecks(target),
      );
      assert.equal(await facts(), before);
      assert.match(
        await sql(
          "SELECT authentication_type, default_tablespace FROM dba_users WHERE username='SKIP_Z_NEW';",
        ),
        /NONE\s+USERS/,
      );
      await assert.rejects(
        sql(
          conditional('SKIP_ROLE') +
            '\nCREATE TABLE SKIP_Z_NEW.AFTER_FAILURE (ID NUMBER);',
        ),
      );
      assert.ok(errors.includes('ORA-01920'));
      errors.length = 0;
      await assert.rejects(
        sql(
          generatedReplay(generateSql(target)) +
            '\nCREATE TABLE SKIP_Z_NEW.AFTER_FAILURE (ID NUMBER);',
        ),
      );
      assert.ok(errors.includes('ORA-00955'));
      await sql(setupChecks(targetFor(['SKIP_A_EXISTING'], false)));
      await assert.rejects(
        sql(setupChecks(targetFor(['SKIP_MISSING'], false))),
      );
      // A proxy session proves missing CREATE USER privilege is still fatal.
      await sql('ALTER USER SKIP_A_EXISTING GRANT CONNECT THROUGH SYSTEM;');
      const portOutput = await runProcess(
        'docker',
        [...testComposeArgs, 'port', 'oracle-destination', '1521'],
        { env: childEnvironment() },
      );
      const restricted = await oracle.getConnection({
        user: 'SYSTEM[SKIP_A_EXISTING]',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${/:(\d+)\s*$/.exec(portOutput)![1]}/FREEPDB1`,
      });
      try {
        await assert.rejects(
          restricted.execute(conditional('SKIP_MISSING').replace(/\n\/$/, '')),
          /ORA-01031/,
        );
      } finally {
        await restricted.close();
      }
      assert.match(
        await sql(
          "SELECT COUNT(*) FROM dba_tables WHERE owner='SKIP_Z_NEW' AND table_name='AFTER_FAILURE';",
        ),
        /^\s*0\s*$/,
      );
    } finally {
      await sql(cleanup);
    }
  },
);

// Opt in because this suite replaces the fixed operational project. It refuses
// any pre-existing operational resources before taking ownership for this test.
test(
  'remote source to disposable local clone: replacement, prerequisites and failures',
  {
    skip: process.env.ORACLE_LOCAL_CLONE_INTEGRATION !== '1',
    timeout: 2_400_000,
  },
  async () => {
    rejectDsnOverrides();
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const docker = (args: string[]) =>
      runProcess('docker', args, {
        env: {
          ...childEnvironment(),
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              key.startsWith('ORACLE_'),
            ),
          ),
        },
        timeoutMs: 1_300_000,
      });
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
      'Refusing an existing operational destination',
    );
    assert.ok(
      !(await docker(['volume', 'ls', '-q'])).split('\n').includes(volume),
      'Refusing an existing operational volume',
    );
    await docker([
      ...testComposeArgs,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '1200',
      'oracle-source',
    ]);
    const published = await docker([
      ...testComposeArgs,
      'port',
      'oracle-source',
      '1521',
    ]);
    const sourceDsn = `127.0.0.1:${/:(\d+)\s*$/.exec(published)![1]}/FREEPDB1`;
    const root = await mkdtemp(join(tmpdir(), 'oracle-local-clone-'));
    for (const directory of ['src', 'scripts'])
      await cp(join(repo, directory), join(root, directory), {
        recursive: true,
      });
    await cp(
      join(repo, 'docker-compose.yml'),
      join(root, 'docker-compose.yml'),
    );
    await symlink(
      join(repo, 'node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: { 'db:clone': 'node --import tsx scripts/clone-database.ts' },
      }),
    );
    await mkdir(join(root, 'config/local'), { recursive: true, mode: 0o700 });
    const config = {
      version: 1,
      source: {
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        dsn: sourceDsn,
        catalogScope: 'dba',
      },
      destination: {
        password: 'CloneFixture987',
        port: 1529,
        startupTimeoutSeconds: 1200,
      },
    };
    await writeFile(
      join(root, 'config/local/config.json'),
      JSON.stringify(config),
      { mode: 0o600 },
    );
    await waitForListener(sourceDsn, config.source.password);
    // This simple independent fixture covers PK, comments, a view, rows and an external default.
    await runProcess(
      'docker',
      [
        ...testComposeArgs,
        'exec',
        '-T',
        'oracle-source',
        'sqlplus',
        '-s',
        '/ as sysdba',
      ],
      {
        env: childEnvironment(),
        input: `WHENEVER SQLERROR EXIT 1\nALTER SESSION SET CONTAINER=FREEPDB1;\nCREATE USER CLONE_FIXTURE NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE USER CLONE_INDEX NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE TABLE CLONE_FIXTURE.T (ID NUMBER, LABEL VARCHAR2(40));\nCREATE UNIQUE INDEX CLONE_INDEX.T_PK ON CLONE_FIXTURE.T(ID);\nALTER TABLE CLONE_FIXTURE.T ADD CONSTRAINT T_PK PRIMARY KEY(ID) USING INDEX CLONE_INDEX.T_PK;\nCOMMENT ON TABLE CLONE_FIXTURE.T IS 'clone table';\nCOMMENT ON COLUMN CLONE_FIXTURE.T.LABEL IS 'clone label';\nINSERT INTO CLONE_FIXTURE.T VALUES (1, 'source row');\nCREATE VIEW CLONE_FIXTURE.V AS SELECT ID, LABEL FROM CLONE_FIXTURE.T;\nCREATE FUNCTION CLONE_FIXTURE.F RETURN NUMBER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM CLONE_FIXTURE.T; RETURN n; END;\n/\nCREATE PACKAGE CLONE_FIXTURE.API AS PROCEDURE P(n OUT NUMBER); END;\n/\nCREATE PACKAGE BODY CLONE_FIXTURE.API AS PROCEDURE P(n OUT NUMBER) IS BEGIN n:=CLONE_FIXTURE.F; END; END;\n/\nCREATE PROCEDURE CLONE_FIXTURE.P(n OUT NUMBER) AS BEGIN CLONE_FIXTURE.API.P(n); END;\n/\nCREATE SEQUENCE CLONE_FIXTURE.EXTERNAL_SEQ;\nCREATE TABLE CLONE_FIXTURE.WITH_DEFAULT (ID NUMBER DEFAULT CLONE_FIXTURE.EXTERNAL_SEQ.NEXTVAL);\nCREATE INDEX CLONE_INDEX.DEFAULT_IX ON CLONE_FIXTURE.WITH_DEFAULT(ID);\nCOMMIT;\nEXIT\n`,
      },
    );
    const selection = {
      version: 3,
      procedures: [
        { owner: 'CLONE_FIXTURE', name: 'P' },
        { owner: 'CLONE_FIXTURE', package: 'API', name: 'P' },
      ],
      packages: [],
      tables: [{ owner: 'CLONE_FIXTURE', name: 'T' }],
      views: [{ owner: 'CLONE_FIXTURE', name: 'V' }],
    };
    await writeFile(
      join(root, 'config/local/objects.json'),
      JSON.stringify(selection),
    );
    await writeFile(join(root, 'config/local/policy.json'), '{}');
    const source = await oracle.getConnection({
      user: 'SYSTEM',
      password: config.source.password,
      connectString: sourceDsn,
    });
    const sourceFacts = async () => ({
      rows: (await source.execute('SELECT * FROM CLONE_FIXTURE.T')).rows,
      programs: (
        await source.execute(
          "SELECT name,type,line,text FROM dba_source WHERE owner='CLONE_FIXTURE' ORDER BY name,type,line",
        )
      ).rows,
      settings: (
        await source.execute(
          "SELECT name,type,plsql_optimize_level,plsql_code_type,plsql_debug,plsql_warnings,nls_length_semantics,plsql_ccflags,plscope_settings FROM dba_plsql_object_settings WHERE owner='CLONE_FIXTURE' ORDER BY name,type",
        )
      ).rows,
    });
    const before = await sourceFacts();
    let destination: ComposeDestination | undefined;
    try {
      const first = await cloneDatabase({ root });
      destination = new ComposeDestination(
        root,
        (await loadCloneConfig(join(root, 'config/local/config.json'))).config
          .destination,
      );
      await destination.preflight();
      assert.equal(
        first.result.status,
        'succeeded',
        JSON.stringify(first.result),
      );

      await destination.sql('CREATE TABLE CLONE_FIXTURE.SENTINEL (ID NUMBER);');
      await assert.rejects(
        destination.sql(
          "BEGIN RAISE_APPLICATION_ERROR(-20224, 'fixture failure'); END;\n/",
        ),
        (error) => {
          assert.equal((error as { childExitCode?: number }).childExitCode, 1);
          return true;
        },
      );
      const generationFailure = await cloneDatabase({
        root,
        run: async (file, args, options) => {
          if (args[3] === 'generate') {
            await writeFile(
              args[args.indexOf('--output') + 1],
              'Existing artifact blocks publication',
              { flag: 'wx' },
            );
          }
          return runProcess(file, args, options);
        },
      });
      assert.equal(generationFailure.result.lastStage, 'generate');
      assert.equal(generationFailure.result.status, 'failed');
      assert.equal(generationFailure.result.destinationResetStarted, false);
      await destination.sql('SELECT * FROM CLONE_FIXTURE.SENTINEL;');
      const oldCreated = JSON.parse(
        await docker(['volume', 'inspect', volume]),
      )[0].CreatedAt;
      const target = targetDocumentSchema.parse(
        JSON.parse(
          await readFile(join(first.directory, 'target.json'), 'utf8'),
        ),
      );
      assert.equal(target.tables[0].indexes[0].reference.owner, 'CLONE_INDEX');
      const wrongAssociation = structuredClone(target);
      const key = wrongAssociation.tables[0].constraints.find(
        (item) => item.kind === 'primary-key',
      )!;
      if (key.kind === 'primary-key')
        key.backingIndex = { owner: 'CLONE_FIXTURE', name: 'T_PK' };
      await assert.rejects(
        destination.sql(verificationChecks(wrongAssociation)),
      );
      await assert.rejects(
        destination.sql(
          verificationChecks({
            ...target,
            views: [
              ...target.views,
              {
                ...target.views[0],
                reference: { owner: 'CLONE_FIXTURE', name: 'MISSING' },
              },
            ],
          }),
        ),
      );
      await destination.sql(
        'CREATE FORCE VIEW CLONE_FIXTURE.INVALID_VIEW AS SELECT X FROM CLONE_FIXTURE.MISSING_TABLE;',
      );
      await assert.rejects(
        destination.sql(
          verificationChecks({
            ...target,
            views: [
              {
                ...target.views[0],
                reference: { owner: 'CLONE_FIXTURE', name: 'INVALID_VIEW' },
              },
            ],
          }),
        ),
      );
      // Generation/validation rejection must preserve the old destination.
      await writeFile(
        join(root, 'config/local/policy.json'),
        '{"maxStringSize":"EXTENDED"}',
      );
      const preflightFailure = await cloneDatabase({ root });
      assert.equal(preflightFailure.result.destinationResetStarted, false);
      await destination.sql('SELECT * FROM CLONE_FIXTURE.SENTINEL;');
      await writeFile(join(root, 'config/local/policy.json'), '{}');
      const priorRuns = await readdir(join(root, 'artifacts'));
      await runProcess('npm', ['run', 'db:clone'], {
        cwd: root,
        env: childEnvironment(),
        timeoutMs: 1_300_000,
      });
      const newRun = (await readdir(join(root, 'artifacts'))).find(
        (name) => !priorRuns.includes(name) && name.startsWith('db-clone-'),
      )!;
      const second = {
        result: JSON.parse(
          await readFile(
            join(root, 'artifacts', newRun, 'run-result.json'),
            'utf8',
          ),
        ),
      };
      assert.equal(
        second.result.status,
        'succeeded',
        JSON.stringify(second.result),
      );
      assert.notEqual(
        JSON.parse(await docker(['volume', 'inspect', volume]))[0].CreatedAt,
        oldCreated,
      );
      await assert.rejects(
        destination.sql('SELECT * FROM CLONE_FIXTURE.SENTINEL;'),
      );
      const connection = await oracle.getConnection({
        user: 'SYSTEM',
        password: config.destination.password,
        connectString: '127.0.0.1:1529/FREEPDB1',
      });
      try {
        assert.deepEqual(
          (await connection.execute('SELECT COUNT(*) FROM CLONE_FIXTURE.T'))
            .rows,
          [[0]],
        );
        assert.deepEqual(
          (
            await connection.execute(
              "SELECT comments FROM dba_tab_comments WHERE owner='CLONE_FIXTURE' AND table_name='T'",
            )
          ).rows,
          [['clone table']],
        );
        assert.deepEqual(
          (
            await connection.execute(
              "SELECT comments FROM dba_col_comments WHERE owner='CLONE_FIXTURE' AND table_name='T' AND column_name='LABEL'",
            )
          ).rows,
          [['clone label']],
        );
        assert.deepEqual(
          (
            await connection.execute(
              "SELECT COUNT(*) FROM dba_constraints WHERE owner='CLONE_FIXTURE' AND table_name='T' AND constraint_type='P'",
            )
          ).rows,
          [[1]],
        );
        assert.deepEqual(
          (await connection.execute('SELECT COUNT(*) FROM CLONE_FIXTURE.V'))
            .rows,
          [[0]],
        );
        console.log(
          'Tested Oracle version:',
          connection.oracleServerVersionString,
          'image:',
          second.result.destinationImageId,
        );
      } finally {
        await connection.close();
      }
      assert.deepEqual(await sourceFacts(), before);
      // Own the operational destination before injecting a partial replay failure.
      class FailingReplayDestination extends ComposeDestination {
        override async sql(sql: string) {
          if (sql.includes('DEFERRED_SEGMENT_CREATION')) {
            await super.sql('CREATE TABLE SYSTEM.RETRY_MARKER (ID NUMBER);');
            throw new CloneError('CLONE_STAGE_FAILED', 1);
          }
          return super.sql(sql);
        }
      }
      const failedReplay = await cloneDatabase({
        root,
        destination: (loaded) =>
          new FailingReplayDestination(root, loaded.config.destination),
      });
      assert.equal(failedReplay.result.errorCode, 'CLONE_REPLAY_FAILED');
      await destination.sql('SELECT * FROM SYSTEM.RETRY_MARKER;');
      const savedNames = [
        'clone.sql',
        'target.json',
        'report.json',
        'target.json.complete.json',
        'run-result.json',
      ];
      const originals = await Promise.all(
        savedNames.map((name) => readFile(join(failedReplay.directory, name))),
      );
      await writeFile(
        join(root, 'config/local/config.json'),
        JSON.stringify({
          version: 1,
          destination: config.destination,
          source: null,
          objects: 'unavailable',
          policy: 'unavailable',
        }),
      );
      const retried = await retryCloneDatabase({
        root,
        input: failedReplay.directory,
      });
      assert.equal(
        retried.result.status,
        'succeeded',
        JSON.stringify(retried.result),
      );
      for (const [index, name] of savedNames.entries())
        assert.deepEqual(
          await readFile(join(failedReplay.directory, name)),
          originals[index],
        );
      const retryConnection = await oracle.getConnection({
        user: 'SYSTEM',
        password: config.destination.password,
        connectString: '127.0.0.1:1529/FREEPDB1',
      });
      try {
        const programResult = await retryConnection.execute(
          'BEGIN CLONE_FIXTURE.P(:n); END;',
          { n: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
        );
        assert.deepEqual(programResult.outBinds, { n: 0 });
        assert.deepEqual(
          (
            await retryConnection.execute(
              "SELECT COUNT(*) FROM dba_objects WHERE owner='CLONE_FIXTURE' AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY') AND status='VALID'",
            )
          ).rows,
          [[4]],
        );

        assert.deepEqual(
          (
            await retryConnection.execute(
              "SELECT COUNT(*) FROM dba_tables WHERE owner='SYSTEM' AND table_name='RETRY_MARKER'",
            )
          ).rows,
          [[0]],
        );
        assert.deepEqual(
          (
            await retryConnection.execute(
              'SELECT COUNT(*) FROM CLONE_FIXTURE.T',
            )
          ).rows,
          [[0]],
        );
        assert.deepEqual(
          (
            await retryConnection.execute(
              'SELECT COUNT(*) FROM CLONE_FIXTURE.V',
            )
          ).rows,
          [[0]],
        );
        assert.deepEqual(
          (
            await retryConnection.execute(
              "SELECT comments FROM dba_tab_comments WHERE owner='CLONE_FIXTURE' AND table_name='T'",
            )
          ).rows,
          [['clone table']],
        );
      } finally {
        await retryConnection.close();
      }
      assert.deepEqual(await sourceFacts(), before);
      // Acknowledgement requires actual owner/sequence provisioning.
      await writeFile(
        join(root, 'config/local/objects.json'),
        JSON.stringify({
          version: 2,
          tables: [{ owner: 'CLONE_FIXTURE', name: 'WITH_DEFAULT' }],
          views: [],
        }),
      );
      await writeFile(
        join(root, 'config/local/policy.json'),
        JSON.stringify({
          createSchemas: false,
          externalPrerequisites: [
            {
              reference: { owner: 'CLONE_FIXTURE', name: 'EXTERNAL_SEQ' },
              type: 'SEQUENCE',
            },
          ],
        }),
      );
      await writeFile(
        join(root, 'config/local/config.json'),
        JSON.stringify({ ...config, prerequisiteSql: 'setup.sql' }),
      );
      await writeFile(
        join(root, 'config/local/setup.sql'),
        'CREATE USER CLONE_FIXTURE NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE SEQUENCE CLONE_FIXTURE.EXTERNAL_SEQ;',
      );
      const missingIndexOwner = await cloneDatabase({ root });
      assert.equal(missingIndexOwner.result.status, 'failed');
      assert.equal(missingIndexOwner.result.lastStage, 'setup-verification');
      assert.match(
        missingIndexOwner.result.errorDetail!,
        /CLONE_INDEX.*missing.*createSchemas=false/,
      );
      assert.ok(
        missingIndexOwner.result.oracleErrorCodes?.includes('ORA-20001'),
      );
      await writeFile(
        join(root, 'config/local/setup.sql'),
        'CREATE USER CLONE_FIXTURE NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE USER CLONE_INDEX NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE SEQUENCE CLONE_FIXTURE.EXTERNAL_SEQ;',
      );
      const prerequisite = await cloneDatabase({ root });
      assert.equal(
        prerequisite.result.status,
        'succeeded',
        JSON.stringify(prerequisite.result),
      );
      await destination.sql(
        'INSERT INTO CLONE_FIXTURE.WITH_DEFAULT VALUES (DEFAULT);',
      );
      await writeFile(
        join(root, 'config/local/setup.sql'),
        'SELECT * FROM DEFINITELY_MISSING_TABLE;',
      );
      const failedSetup = await cloneDatabase({ root });
      assert.equal(failedSetup.result.errorCode, 'CLONE_PREREQUISITE_FAILED');
      assert.equal(failedSetup.result.lastStage, 'prerequisite');
      assert.deepEqual(await sourceFacts(), before);
    } finally {
      await source.close();
      if (destination) await destination.reset();
      await runProcess(
        'docker',
        [
          ...testComposeArgs,
          'exec',
          '-T',
          'oracle-source',
          'sqlplus',
          '-s',
          '/ as sysdba',
        ],
        {
          env: childEnvironment(),
          input:
            'ALTER SESSION SET CONTAINER=FREEPDB1;\nDROP USER CLONE_FIXTURE CASCADE;\nDROP USER CLONE_INDEX CASCADE;\nEXIT\n',
        },
      );
    }
  },
);
