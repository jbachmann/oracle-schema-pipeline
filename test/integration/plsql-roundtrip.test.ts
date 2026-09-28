import { extractSource } from '../../src/extract.js';
import { transformSource } from '../../src/transform.js';
import { generateSql } from '../../src/generate.js';
import { policySchema } from '../../src/model.js';
import {
  generatedReplay,
  verificationChecks,
} from '../../scripts/compose-destination.js';
import { OracleCatalog } from '../../src/catalog.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle from 'oracledb';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';
import { childEnvironment, runProcess } from '../../scripts/process.js';
import { sqlSession } from '../../scripts/compose-destination.js';
import { renderProgramDdl } from '../../src/plsql-ddl.js';

// Probes write only to a disposable schema on the explicit test destination.
test(
  'CLOB program replay preserves large source and rejects invalid units and collisions',
  { timeout: 180_000 },
  async () => {
    rejectDsnOverrides();
    const oracleCodes: string[] = [];
    const command = (args: string[], input?: string) =>
      runProcess('docker', [...testComposeArgs, ...args], {
        env: childEnvironment(),
        input,
        timeoutMs: 120_000,
        onProgressLine: ({ line }) => {
          const code = /(?:ORA|PLS)-\d{5}/.exec(line)?.[0];
          if (code) oracleCodes.push(code);
        },
      });
    const sql = async (input: string) => {
      oracleCodes.length = 0;
      try {
        return await command(
          ['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'],
          sqlSession(input),
        );
      } catch {
        throw new Error(`Oracle replay failed: ${oracleCodes.join(', ')}`);
      }
    };
    const drop =
      "BEGIN EXECUTE IMMEDIATE 'DROP USER PLSQL_PROBE CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;\n/";
    await sql(drop);
    let connection: oracle.Connection | undefined;
    try {
      await sql('CREATE USER PLSQL_PROBE NO AUTHENTICATION;');
      const reference = { owner: 'PLSQL_PROBE', name: 'API' };
      const specification =
        'PACKAGE API AUTHID DEFINER AS\n PROCEDURE P(v OUT NUMBER);\n PROCEDURE P(v OUT VARCHAR2);\n FUNCTION COUNT_IT RETURN NUMBER;\nEND;\n';
      const body = `PACKAGE BODY API AS\n/* ${'padding '.repeat(5000)}\n/\nHOST false\n&client_variable\n*/\n PROCEDURE P(v OUT NUMBER) IS BEGIN v := 42; END;\n PROCEDURE P(v OUT VARCHAR2) IS BEGIN v := q'[π & value]'; END;\n FUNCTION COUNT_IT RETURN NUMBER IS BEGIN RETURN 2; END;\nEND;\n`;
      await sql(
        renderProgramDdl({
          reference,
          type: 'PACKAGE',
          source: specification,
          editionable: true,
          operationIndex: 0,
        }),
      );
      await sql(
        renderProgramDdl({
          reference,
          type: 'PACKAGE BODY',
          source: body,
          editionable: true,
          operationIndex: 1,
        }),
      );
      const port = /:(\d+)\s*$/.exec(
        await command(['port', 'oracle-destination', '1521']),
      )![1];
      connection = await oracle.getConnection({
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
      const extracted = await extractSource(
        new OracleCatalog(connection, 'dba'),
        {
          version: 3,
          tables: [],
          views: [],
          procedures: [{ owner: 'PLSQL_PROBE', package: 'API', name: 'P' }],
          packages: [],
        },
      );
      await assert.rejects(
        extractSource(new OracleCatalog(connection, 'dba'), {
          version: 3,
          tables: [],
          views: [],
          procedures: [
            { owner: 'PLSQL_PROBE', package: 'API', name: 'COUNT_IT' },
          ],
          packages: [],
        }),
        /PLSQL_MEMBER_NOT_FOUND/u,
      );
      const prepared = transformSource(extracted, policySchema.parse({}));
      const replay = generatedReplay(generateSql(prepared));
      const captured = await new OracleCatalog(connection, 'dba').program(
        reference,
      );
      assert.equal(captured.kind, 'package');
      assert.equal(captured.units.length, 2);
      if (captured.kind === 'package') {
        assert.equal(captured.bodyRequired, true);
        assert.equal(captured.publicProcedures.length, 2);
      }
      const result = await connection.execute<{ TEXT: string }>(
        "SELECT text FROM dba_source WHERE owner='PLSQL_PROBE' AND name='API' AND type='PACKAGE BODY' ORDER BY line",
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      const reconstructed = result.rows!.map((row) => row.TEXT ?? '').join('');
      // Oracle strips the schema qualifier and normalizes the declaration keyword.
      assert.equal(
        reconstructed.slice(reconstructed.indexOf(' AS')),
        body.slice(body.indexOf(' AS')),
      );
      const members = await connection.execute<{
        PROCEDURE_NAME: string;
        OVERLOAD: string;
      }>(
        "SELECT procedure_name, overload FROM dba_procedures WHERE owner='PLSQL_PROBE' AND object_name='API' AND procedure_name='P' ORDER BY subprogram_id",
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      assert.deepEqual(
        members.rows!.map((row) => row.PROCEDURE_NAME),
        ['P', 'P'],
      );
      assert.equal(new Set(members.rows!.map((row) => row.OVERLOAD)).size, 2);
      const value = await connection.execute(
        'BEGIN PLSQL_PROBE.API.P(:v); END;',
        { v: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
      );
      assert.equal((value.outBinds as { v: number }).v, 42);
      await assert.rejects(
        sql(
          renderProgramDdl({
            reference,
            type: 'PACKAGE',
            source: specification,
            editionable: true,
            operationIndex: 2,
          }),
        ),
      );
      await assert.rejects(
        sql(
          renderProgramDdl({
            reference: { owner: 'PLSQL_PROBE', name: 'BAD' },
            type: 'PROCEDURE',
            source: 'PROCEDURE BAD AS BEGIN missing_identifier; END;',
            editionable: true,
            operationIndex: 3,
          }),
        ),
      );
      const sessionSettings = async () =>
        (
          await connection!.execute(
            "SELECT name,value FROM v$parameter WHERE name IN ('plsql_optimize_level','plsql_code_type','plsql_debug','plsql_warnings','nls_length_semantics','plsql_ccflags','plscope_settings') ORDER BY name",
          )
        ).rows;
      const originalSettings = await sessionSettings();
      const warningDdl = renderProgramDdl({
        reference: { owner: 'PLSQL_PROBE', name: 'WARNING_UNIT' },
        type: 'PROCEDURE',
        source: 'PROCEDURE WARNING_UNIT AS BEGIN RETURN; NULL; END;',
        editionable: false,
        operationIndex: 8,
        settings: {
          plsqlOptimizeLevel: 1,
          plsqlCodeType: 'INTERPRETED',
          plsqlDebug: false,
          plsqlWarnings: 'ENABLE:ALL',
          nlsLengthSemantics: 'CHAR',
          plsqlCcflags: 'probe:TRUE',
          plscopeSettings: 'IDENTIFIERS:ALL',
        },
      });
      const anonymousDdl = warningDdl.split('\n/\n')[0];
      await connection.execute(anonymousDdl);
      const temporaryLobs = async () =>
        Number(
          (
            await connection!.execute<{ N: number }>(
              "SELECT NVL(SUM(cache_lobs+nocache_lobs),0) n FROM v$temporary_lobs WHERE sid=SYS_CONTEXT('USERENV','SID')",
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows![0].N,
        );
      await assert.rejects(connection.execute(anonymousDdl));
      const openCursors = async () =>
        Number(
          (
            await connection!.execute<{ N: number }>(
              "SELECT s.value n FROM v$sesstat s JOIN v$statname n ON n.statistic#=s.statistic# WHERE s.sid=SYS_CONTEXT('USERENV','SID') AND n.name='opened cursors current'",
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows![0].N,
        );
      const beforeCursors = await openCursors();
      const beforeLobs = await temporaryLobs();
      for (let index = 0; index < 5; index++)
        await assert.rejects(connection.execute(anonymousDdl));
      assert.equal(await temporaryLobs(), beforeLobs);
      assert.ok(
        (await openCursors()) <= beforeCursors + 1,
        'Repeated failed parses must not accumulate cursors',
      );
      assert.deepEqual(await sessionSettings(), originalSettings);
      const warnings = await connection.execute<{ N: number }>(
        "SELECT COUNT(*) n FROM dba_errors WHERE owner='PLSQL_PROBE' AND name='WARNING_UNIT' AND attribute='WARNING'",
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      assert.ok(warnings.rows![0].N > 0);
      await sql(drop);
      await sql(replay);
      await sql(verificationChecks(prepared));
      const recaptured = await new OracleCatalog(connection, 'dba').program(
        reference,
      );
      assert.deepEqual(
        recaptured.units.map((unit) => unit.settings),
        captured.units.map((unit) => unit.settings),
      );
    } finally {
      await connection?.close();
      await sql(drop);
    }
  },
);

test(
  'seeded procedure recursively reconstructs package, private helper, function and table without source writes',
  { timeout: 240_000 },
  async () => {
    rejectDsnOverrides();
    const command = (args: string[], input?: string) =>
      runProcess('docker', [...testComposeArgs, ...args], {
        env: childEnvironment(),
        input,
        timeoutMs: 120_000,
      });
    const connect = async (service: string, user = 'SYSTEM') => {
      const port = /:(\d+)\s*$/.exec(
        await command(['port', service, '1521']),
      )![1];
      return oracle.getConnection({
        user,
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
    };
    const source = await connect('oracle-source');
    let destination: oracle.Connection | undefined;
    const snapshot = async () => {
      const source = await sourceConnection.execute(
        "SELECT owner,name,type,line,text FROM dba_source WHERE owner='IAM' ORDER BY name,type,line",
        {},
        { outFormat: oracle.OUT_FORMAT_ARRAY },
      );
      const settings = await sourceConnection.execute(
        "SELECT owner,name,type,plsql_optimize_level,plsql_code_type,plsql_debug,plsql_warnings,nls_length_semantics,plsql_ccflags,plscope_settings FROM dba_plsql_object_settings WHERE owner='IAM' ORDER BY name,type",
        {},
        { outFormat: oracle.OUT_FORMAT_ARRAY },
      );
      return { source: source.rows, settings: settings.rows };
    };
    const sourceConnection = source;
    try {
      const before = await snapshot();
      const captured = await extractSource(new OracleCatalog(source, 'dba'), {
        version: 3,
        tables: [],
        views: [],
        procedures: [
          { owner: 'IAM', name: 'PROCESS_PERMISSION' },
          {
            owner: 'IAM',
            package: 'PERMISSION_API',
            name: 'PROCESS_PERMISSION',
          },
        ],
        packages: [],
      });
      for (const name of ['TOUCH_PERMISSION', 'MISSING'])
        await assert.rejects(
          extractSource(new OracleCatalog(source, 'dba'), {
            version: 3,
            tables: [],
            views: [],
            procedures: [{ owner: 'IAM', package: 'PERMISSION_API', name }],
            packages: [],
          }),
          /PLSQL_MEMBER_NOT_FOUND/u,
        );
      assert.equal(captured.programs.length, 3);
      assert.equal(captured.tables.length, 1);
      assert.equal(captured.tables[0].reference.name, 'PERMISSIONS');
      const target = transformSource(captured, policySchema.parse({}));
      const reset =
        "BEGIN FOR r IN (SELECT username FROM dba_users WHERE username IN ('IAM','INDEX_SCHEMA') ORDER BY CASE WHEN username='INDEX_SCHEMA' THEN 1 ELSE 0 END) LOOP EXECUTE IMMEDIATE 'DROP USER '||r.username||' CASCADE'; END LOOP; END;\n/";
      await command(
        ['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'],
        sqlSession(
          reset +
            '\n' +
            generatedReplay(generateSql(target)) +
            '\n' +
            verificationChecks(target),
        ),
      );
      destination = await connect('oracle-destination');
      const { assertIndependentProgramFacts } =
        await import('./independent-facts.js');
      await assertIndependentProgramFacts(destination);
      await destination.execute(
        "INSERT INTO IAM.PERMISSIONS(PERMISSION_ID,PERMISSION_KEY,RESOURCE_TYPE,ACTION_NAME) VALUES(987654321,'program.probe','TEST','PENDING')",
      );
      await destination.execute(
        'BEGIN IAM.PROCESS_PERMISSION(987654321); END;',
      );
      const result = await destination.execute<{ ACTION_NAME: string }>(
        'SELECT action_name FROM IAM.PERMISSIONS WHERE permission_id=987654321',
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      assert.equal(result.rows![0].ACTION_NAME, 'PROCESSED');
      const calls = await destination.execute(
        'BEGIN IAM.PERMISSION_API.PROCESS_PERMISSION(987654321,:n); END;',
        { n: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
      );
      assert.equal((calls.outBinds as { n: number }).n, 2);
      await destination.rollback();
      assert.deepEqual(await snapshot(), before);
      const own = await connect('oracle-source', 'SYSTEM[IAM]');
      try {
        await assert.rejects(
          new OracleCatalog(own, 'all').program({
            owner: 'IAM',
            name: 'PERMISSION_API',
          }),
          /CATALOG_INCOMPLETE_METADATA.*sourceOwnerEditionsEnabled/u,
        );
        const constants = await new OracleCatalog(source, 'dba').program({
          owner: 'IAM',
          name: 'PROGRAM_CONSTANTS',
        });
        assert.equal(
          constants.kind === 'package' && constants.bodyRequired,
          false,
        );
        assert.equal(constants.units.length, 1);
      } finally {
        await own.close();
      }
      const limited = await connect('oracle-source', 'SYSTEM[LIMITED_READER]');
      try {
        await assert.rejects(
          new OracleCatalog(limited, 'all').program({
            owner: 'IAM',
            name: 'PERMISSION_API',
          }),
          /CATALOG_/u,
        );
      } finally {
        await limited.close();
      }
    } finally {
      await destination?.rollback();
      await destination?.close();
      await source.close();
    }
  },
);

test(
  'mixed views, function indexes, cross-owner grants and mutually calling package bodies compile in dependency order',
  { timeout: 240_000 },
  async () => {
    rejectDsnOverrides();
    const oracleCodes: string[] = [];
    const command = (args: string[], input?: string) =>
      runProcess('docker', [...testComposeArgs, ...args], {
        env: childEnvironment(),
        input,
        timeoutMs: 120_000,
        onProgressLine: ({ line }) => {
          const code = /(?:ORA|PLS)-\d{5}/.exec(line)?.[0];
          if (code) oracleCodes.push(code);
        },
      });
    const sql = async (input: string) => {
      oracleCodes.length = 0;
      try {
        return await command(
          ['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'],
          sqlSession(input),
        );
      } catch {
        throw new Error(`Oracle replay failed: ${oracleCodes.join(', ')}`);
      }
    };
    const names = ['PG_DATA', 'PG_UTIL', 'PG_CALLER'];
    const drop = names
      .map(
        (name) =>
          `BEGIN EXECUTE IMMEDIATE 'DROP USER ${name} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE <> -1918 THEN RAISE; END IF; END;\n/`,
      )
      .join('\n');
    await sql(drop);
    let connection: oracle.Connection | undefined;
    try {
      await sql(
        names
          .map(
            (name) =>
              `CREATE USER ${name} NO AUTHENTICATION DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;`,
          )
          .join('\n') +
          `
CREATE TABLE PG_DATA.T(ID NUMBER PRIMARY KEY, STATUS VARCHAR2(20));
CREATE FUNCTION PG_DATA.F(n NUMBER) RETURN NUMBER AUTHID CURRENT_USER DETERMINISTIC AS BEGIN RETURN n+1; END;
/
GRANT EXECUTE ON PG_DATA.F TO PG_UTIL;
CREATE INDEX PG_UTIL.F_IX ON PG_DATA.T(PG_DATA.F(ID));
CREATE VIEW PG_DATA.V AS SELECT PG_DATA.F(ID) AS ID FROM PG_DATA.T;
CREATE PACKAGE PG_UTIL.A AS PROCEDURE P(n IN OUT NUMBER); END;
/
CREATE PACKAGE PG_UTIL.B AS PROCEDURE P(n IN OUT NUMBER); END;
/
CREATE PACKAGE BODY PG_UTIL.A AS PROCEDURE P(n IN OUT NUMBER) IS BEGIN n:=n+1; IF n<2 THEN PG_UTIL.B.P(n); END IF; END; END;
/
CREATE PACKAGE BODY PG_UTIL.B AS PROCEDURE P(n IN OUT NUMBER) IS BEGIN n:=n+1; IF n<2 THEN PG_UTIL.A.P(n); END IF; END; END;
/
GRANT EXECUTE ON PG_UTIL.A TO PG_CALLER;
GRANT SELECT ON PG_DATA.V TO PG_CALLER;
GRANT SELECT, UPDATE ON PG_DATA.T TO PG_CALLER;
CREATE PROCEDURE PG_CALLER.RUN_IT(n OUT NUMBER) AUTHID DEFINER AS k NUMBER; BEGIN SELECT COUNT(*) INTO k FROM PG_DATA.V; n:=0; PG_UTIL.A.P(n); UPDATE PG_DATA.T SET STATUS='DONE'; END;
/`,
      );
      const port = /:(\d+)\s*$/.exec(
        await command(['port', 'oracle-destination', '1521']),
      )![1];
      connection = await oracle.getConnection({
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
      const compilation = await connection.execute(
        "SELECT name,type,line,position,message_number,REGEXP_SUBSTR(text,'ORA-[0-9]{5}') AS oracle_code FROM dba_errors WHERE owner IN ('PG_DATA','PG_UTIL','PG_CALLER') AND attribute='ERROR' ORDER BY owner,name,sequence",
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      assert.deepEqual(
        compilation.rows,
        [],
        'Bootstrap fixture must compile before extraction',
      );
      const captured = await extractSource(
        new OracleCatalog(connection, 'dba'),
        {
          version: 3,
          tables: [],
          views: [],
          packages: [],
          procedures: [{ owner: 'PG_CALLER', name: 'RUN_IT' }],
        },
      );
      assert.equal(captured.programs.length, 4);
      assert.equal(captured.tables.length, 1);
      assert.equal(captured.views.length, 1);
      const policy = policySchema.parse({
        version: 2,
        plsqlObjectGrants: [
          {
            reference: { owner: 'PG_DATA', name: 'V' },
            grantee: 'PG_CALLER',
            privileges: ['SELECT'],
          },
          {
            reference: { owner: 'PG_DATA', name: 'T' },
            grantee: 'PG_CALLER',
            privileges: ['SELECT', 'UPDATE'],
          },
        ],
      });
      const target = transformSource(captured, policy);
      const replay = generatedReplay(generateSql(target));
      await sql(drop + '\n' + replay + '\n' + verificationChecks(target));
      await connection.execute("INSERT INTO PG_DATA.T VALUES(1,'PENDING')");
      const result = await connection.execute(
        'BEGIN PG_CALLER.RUN_IT(:n); END;',
        { n: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
      );
      assert.equal((result.outBinds as { n: number }).n, 2);
      const rows = await connection.execute<{ STATUS: string }>(
        'SELECT status FROM PG_DATA.T',
        {},
        { outFormat: oracle.OUT_FORMAT_OBJECT },
      );
      assert.equal(rows.rows![0].STATUS, 'DONE');
      await connection.rollback();
      const insufficient = structuredClone(target);
      if (insufficient.policy.version === 2)
        insufficient.policy.plsqlObjectGrants[1].privileges = ['SELECT'];
      await sql(drop);
      oracleCodes.length = 0;
      await assert.rejects(sql(generatedReplay(generateSql(insufficient))));
      assert.ok(
        oracleCodes.includes('ORA-20020'),
        `Expected compilation assertion, got ${oracleCodes.join(',')}`,
      );
    } finally {
      await connection?.close();
      await sql(drop);
    }
  },
);
