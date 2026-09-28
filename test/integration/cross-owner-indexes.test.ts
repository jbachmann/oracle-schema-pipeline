import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle from 'oracledb';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';
import { waitForListener } from '../scripts/readiness.js';
import { childEnvironment, runProcess } from '../../scripts/process.js';
import { OracleCatalog } from '../../src/catalog.js';
import { extractSource } from '../../src/extract.js';
import { transformSource } from '../../src/transform.js';
import { generateSql } from '../../src/generate.js';
import { policySchema } from '../../src/model.js';
import {
  generatedReplay,
  setupChecks,
  verificationChecks,
  sqlSession,
} from '../../scripts/compose-destination.js';

// All writes are confined to disposable schemas in the explicit test destination.
test(
  'cross-owner indexes preserve backing identities and exact function grants on Oracle',
  { timeout: 1_500_000 },
  async () => {
    rejectDsnOverrides();
    const oracleErrors: string[] = [];
    const command = (args: string[], input?: string) =>
      runProcess('docker', [...testComposeArgs, ...args], {
        env: childEnvironment(),
        input,
        timeoutMs: 120_000,
        onProgressLine: ({ line }) => {
          const code = /ORA-\d{5}/.exec(line)?.[0];
          if (code) oracleErrors.push(code);
        },
      });
    const sql = (input: string) =>
      command(
        ['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'],
        sqlSession(input),
      );
    const owners = ['XI_APP', 'XI_IDX', 'XI_UTIL', 'XI_EXEC', 'XI_NOQUOTA'];
    const drop = (names: string[]) =>
      names
        .map(
          (name) =>
            `BEGIN EXECUTE IMMEDIATE 'DROP USER ${name} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;\n/`,
        )
        .join('\n');
    const create = (names: string[]) =>
      names
        .map(
          (name) =>
            `CREATE USER ${name} NO AUTHENTICATION DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;`,
        )
        .join('\n');
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
    await sql(drop(owners));
    let connection: oracle.Connection | undefined;
    try {
      await sql(`${create(owners)}
CREATE FUNCTION XI_UTIL.NORMALIZE_VALUE(v NUMBER) RETURN NUMBER DETERMINISTIC IS BEGIN RETURN v+1; END;
/
CREATE PACKAGE XI_UTIL.NORMALIZERS AS FUNCTION VALUE_OF(v NUMBER) RETURN NUMBER DETERMINISTIC; END;
/
CREATE PACKAGE BODY XI_UTIL.NORMALIZERS AS FUNCTION VALUE_OF(v NUMBER) RETURN NUMBER DETERMINISTIC IS BEGIN RETURN v+2; END; END;
/
GRANT EXECUTE ON XI_UTIL.NORMALIZE_VALUE TO XI_IDX;
GRANT EXECUTE ON XI_UTIL.NORMALIZERS TO XI_IDX;
CREATE TABLE XI_APP.T (ID NUMBER, CODE NUMBER, OTHER NUMBER);
CREATE UNIQUE INDEX XI_IDX.PK_T ON XI_APP.T(ID);
ALTER TABLE XI_APP.T ADD CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX XI_IDX.PK_T;
CREATE INDEX XI_IDX.UK_T ON XI_APP.T(CODE);
ALTER TABLE XI_APP.T ADD CONSTRAINT UK_T UNIQUE(CODE) DEFERRABLE USING INDEX XI_IDX.UK_T;
CREATE INDEX XI_IDX.BUILTIN ON XI_APP.T(ABS(OTHER));
CREATE INDEX XI_IDX.FUNC ON XI_APP.T(XI_UTIL.NORMALIZE_VALUE(OTHER));
CREATE INDEX XI_IDX.PKG ON XI_APP.T(XI_UTIL.NORMALIZERS.VALUE_OF(OTHER));
CREATE UNIQUE INDEX XI_IDX.STANDALONE_UQ ON XI_APP.T(ID,CODE);`);
      const port = /:(\d+)\s*$/.exec(
        await command(['port', 'oracle-destination', '1521']),
      )![1];
      await waitForListener(
        `127.0.0.1:${port}/FREEPDB1`,
        process.env.ORACLE_PWD ?? 'OracleDev123',
      );
      connection = await oracle.getConnection({
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
      const selection = {
        version: 2 as const,
        tables: [{ owner: 'XI_APP', name: 'T' }],
        views: [],
      };
      const source = await extractSource(
        new OracleCatalog(connection, 'dba'),
        selection,
      );
      const byName = new Map(
        source.tables[0].indexes.map((index) => [index.reference.name, index]),
      );
      assert.deepEqual(byName.get('BUILTIN')!.dependencies, []);
      assert.deepEqual(byName.get('FUNC')!.dependencies, [
        {
          reference: { owner: 'XI_UTIL', name: 'NORMALIZE_VALUE' },
          type: 'FUNCTION',
          databaseLink: null,
        },
      ]);
      assert.deepEqual(byName.get('PKG')!.dependencies, [
        {
          reference: { owner: 'XI_UTIL', name: 'NORMALIZERS' },
          type: 'PACKAGE',
          databaseLink: null,
        },
      ]);
      const all = await extractSource(
        new OracleCatalog(connection, 'all'),
        selection,
      );
      assert.deepEqual(all.tables, source.tables);
      const snapshot = JSON.stringify(source);
      const target = transformSource(
        source,
        policySchema.parse({
          createSchemas: false,
          externalPrerequisites: [
            {
              reference: { owner: 'XI_UTIL', name: 'NORMALIZE_VALUE' },
              type: 'FUNCTION',
            },
            {
              reference: { owner: 'XI_UTIL', name: 'NORMALIZERS' },
              type: 'PACKAGE',
            },
          ],
        }),
      );
      const generated = generateSql(target);
      assert.equal(JSON.stringify(source), snapshot);
      await sql(
        `${drop(['XI_APP', 'XI_IDX'])}\n${create(['XI_APP', 'XI_IDX'])}`,
      );
      const rows = async (query: string) =>
        (
          await connection!.execute(
            query,
            {},
            { outFormat: oracle.OUT_FORMAT_ARRAY },
          )
        ).rows;
      assert.deepEqual(
        await rows(
          "SELECT privilege FROM dba_tab_privs WHERE grantee='XI_IDX'",
        ),
        [],
      );
      await sql(
        setupChecks(target) +
          generatedReplay(generated) +
          '\n' +
          verificationChecks(target),
      );
      assert.deepEqual(
        await rows(
          "SELECT table_name, privilege FROM dba_tab_privs WHERE grantee='XI_IDX' ORDER BY table_name",
        ),
        [
          ['NORMALIZERS', 'EXECUTE'],
          ['NORMALIZE_VALUE', 'EXECUTE'],
        ],
      );
      assert.deepEqual(
        await rows(
          "SELECT index_name, table_owner, table_name FROM dba_indexes WHERE owner='XI_IDX' ORDER BY index_name",
        ),
        ['BUILTIN', 'FUNC', 'PKG', 'PK_T', 'STANDALONE_UQ', 'UK_T'].map(
          (name) => [name, 'XI_APP', 'T'],
        ),
      );
      assert.deepEqual(
        await rows(
          "SELECT constraint_name, index_owner, index_name FROM dba_constraints WHERE owner='XI_APP' AND constraint_type IN ('P','U') ORDER BY constraint_name",
        ),
        [
          ['PK_T', 'XI_IDX', 'PK_T'],
          ['UK_T', 'XI_IDX', 'UK_T'],
        ],
      );
      await connection.execute('INSERT INTO XI_APP.T VALUES (1, 2, 3)');
      await assert.rejects(
        connection.execute('INSERT INTO XI_APP.T VALUES (1, 3, 4)'),
        /ORA-00001/,
      );
      await assert.rejects(
        connection.execute('INSERT INTO XI_APP.T VALUES (2, 2, 4)'),
        /ORA-00001/,
      );
      await connection.rollback();
      // Verification must catch an existing valid index bound to a different table.
      const wrongTable = structuredClone(target);
      wrongTable.tables[0].reference.name = 'WRONG_TABLE';
      await assert.rejects(sql(verificationChecks(wrongTable)));
      const wrongBacking = structuredClone(target);
      const pk = wrongBacking.tables[0].constraints.find(
        (item) => item.kind === 'primary-key',
      )!;
      if (pk.kind === 'primary-key')
        pk.backingIndex = { owner: 'XI_IDX', name: 'UK_T' };
      await assert.rejects(sql(verificationChecks(wrongBacking)));

      await assert.rejects(
        connection.execute('CREATE INDEX XI_MISSING.I ON XI_APP.T(ID, OTHER)'),
        /ORA-01918/,
      );
      await sql('ALTER USER XI_NOQUOTA QUOTA 0 ON USERS;');
      await connection.execute('INSERT INTO XI_APP.T VALUES (1, 2, 3)');
      await connection.commit();
      await assert.rejects(
        connection.execute('CREATE INDEX XI_NOQUOTA.I ON XI_APP.T(ID, OTHER)'),
        /ORA-01950|ORA-01536/,
      );
      await connection.execute('DELETE FROM XI_APP.T');
      await connection.commit();
      await sql(
        'GRANT CREATE SESSION TO XI_EXEC;\nGRANT SELECT, INDEX ON XI_APP.T TO XI_EXEC;\nALTER USER XI_EXEC GRANT CONNECT THROUGH SYSTEM;',
      );
      const restricted = await oracle.getConnection({
        user: 'SYSTEM[XI_EXEC]',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
      try {
        await assert.rejects(
          restricted.execute(
            'CREATE INDEX XI_IDX.DENIED ON XI_APP.T(ID, OTHER)',
          ),
          /ORA-01031/,
        );
        await assert.rejects(
          restricted.execute('GRANT EXECUTE ON XI_UTIL.NORMALIZERS TO XI_IDX'),
          /ORA-01031|ORA-04042|ORA-00942/,
        );
      } finally {
        await restricted.close();
      }
      // SQL*Plus must stop on a denied grant before the following index is attempted.
      // The credential travels only on stdin, with echo/verify disabled; never in arguments or artifacts.
      const password = (process.env.ORACLE_PWD ?? 'OracleDev123').replaceAll(
        '"',
        '""',
      );
      await sql('GRANT CREATE ANY INDEX TO XI_EXEC;');
      oracleErrors.length = 0;
      await assert.rejects(
        command(
          ['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/nolog'],
          `WHENEVER SQLERROR EXIT 1 ROLLBACK\nSET ECHO OFF VERIFY OFF DEFINE OFF\nCONNECT SYSTEM[XI_EXEC]/"${password}"@//localhost:1521/FREEPDB1\nGRANT EXECUTE ON XI_UTIL.NORMALIZERS TO XI_IDX;\nCREATE INDEX XI_IDX.AFTER_DENIED ON XI_APP.T(ID, OTHER);\nEXIT SUCCESS\n`,
        ),
      );
      assert.ok(
        oracleErrors.some((code) =>
          ['ORA-01031', 'ORA-04042', 'ORA-00942'].includes(code),
        ),
      );
      assert.deepEqual(
        await rows(
          "SELECT index_name FROM dba_indexes WHERE owner='XI_IDX' AND index_name='AFTER_DENIED'",
        ),
        [],
      );
      await sql('GRANT EXECUTE ON XI_UTIL.NORMALIZERS TO XI_IDX;');
      await sql(verificationChecks(target));
    } finally {
      await connection?.close();
      await sql(drop(owners));
    }
  },
);
