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
import { cloneDatabase } from '../../scripts/clone-workflow.js';
import { childEnvironment, runProcess } from '../../scripts/process.js';
import {
  ComposeDestination,
  project,
  volume,
  verificationChecks,
} from '../../scripts/compose-destination.js';
import { loadCloneConfig } from '../../scripts/clone-config.js';
import { targetDocumentSchema } from '../../src/model.js';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';

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
        input: `WHENEVER SQLERROR EXIT 1\nALTER SESSION SET CONTAINER=FREEPDB1;\nCREATE USER CLONE_FIXTURE NO AUTHENTICATION QUOTA UNLIMITED ON USERS;\nCREATE TABLE CLONE_FIXTURE.T (ID NUMBER PRIMARY KEY, LABEL VARCHAR2(40));\nCOMMENT ON TABLE CLONE_FIXTURE.T IS 'clone table';\nCOMMENT ON COLUMN CLONE_FIXTURE.T.LABEL IS 'clone label';\nINSERT INTO CLONE_FIXTURE.T VALUES (1, 'source row');\nCREATE VIEW CLONE_FIXTURE.V AS SELECT ID, LABEL FROM CLONE_FIXTURE.T;\nCREATE SEQUENCE CLONE_FIXTURE.EXTERNAL_SEQ;\nCREATE TABLE CLONE_FIXTURE.WITH_DEFAULT (ID NUMBER DEFAULT CLONE_FIXTURE.EXTERNAL_SEQ.NEXTVAL);\nCOMMIT;\nEXIT\n`,
      },
    );
    const selection = {
      version: 2,
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
    const sourceFacts = async () =>
      (await source.execute('SELECT * FROM CLONE_FIXTURE.T')).rows;
    const before = await sourceFacts();
    let destination: ComposeDestination | undefined;
    try {
      const first = await cloneDatabase({ root });
      assert.equal(
        first.result.status,
        'succeeded',
        JSON.stringify(first.result),
      );
      destination = new ComposeDestination(
        root,
        (await loadCloneConfig(join(root, 'config/local/config.json'))).config
          .destination,
      );
      await destination.preflight();
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
            'ALTER SESSION SET CONTAINER=FREEPDB1;\nDROP USER CLONE_FIXTURE CASCADE;\nEXIT\n',
        },
      );
    }
  },
);
