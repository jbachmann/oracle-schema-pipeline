import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle from 'oracledb';
import { spawn } from 'node:child_process';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';
import { OracleCatalog } from '../../src/catalog.js';
import { extractSource } from '../../src/extract.js';
import { policySchema } from '../../src/model.js';
import { transformSource } from '../../src/transform.js';
import { generateSql } from '../../src/generate.js';
import { renderProgram } from '../../src/program-ddl.js';
import { program } from '../program-fixtures.js';
import {
  generatedReplay,
  sqlSession,
  verificationChecks,
} from '../../scripts/compose-destination.js';

function compose(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...testComposeArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(output)),
    );
    child.stdin.end(input);
  });
}

test(
  'seeded source program extraction preserves allocation and restricted readers never assume hidden package-body absence',
  { timeout: 120_000 },
  async () => {
    rejectDsnOverrides();
    const port = (await compose(['port', 'oracle-source', '1521']))
      .trim()
      .split(':')
      .pop();
    const options = {
      password: process.env.ORACLE_PWD ?? 'OracleDev123',
      connectString: `127.0.0.1:${port}/FREEPDB1`,
    };
    const source = await oracle.getConnection({ ...options, user: 'SYSTEM' });
    const restricted = await oracle.getConnection({
      ...options,
      user: 'SYSTEM[SCHEMA_READER]',
    });
    try {
      const state = async () =>
        (
          await source.execute(
            "SELECT last_number FROM dba_sequences WHERE sequence_owner='IAM' AND sequence_name='OSP_ORDER_SEQ'",
          )
        ).rows;
      const before = await state();
      const document = await extractSource(new OracleCatalog(source, 'dba'), {
        version: 3,
        procedures: [
          { owner: 'IAM', name: 'OSP_NOOP' },
          { owner: 'IAM', package: 'OSP_API', name: 'OVERLOADED' },
        ],
        functions: [{ owner: 'IAM', name: 'OSP_NORMALIZE' }],
        packages: [{ owner: 'IAM', name: 'OSP_CONSTANTS' }],
        sequences: [{ owner: 'IAM', name: 'OSP_ORDER_SEQ' }],
        synonyms: [{ owner: 'IAM', name: 'OSP_NEXT_ORDER' }],
      });
      assert.equal(document.programUnits.length, 5);
      assert.equal(
        document.programUnits
          .find(
            (unit) =>
              unit.reference.name === 'OSP_API' && unit.type === 'PACKAGE',
          )!
          .members.filter((member) => member.name === 'OVERLOADED').length,
        2,
      );
      assert.doesNotThrow(() =>
        generateSql(transformSource(document, policySchema.parse({}))),
      );
      const ordinary = await extractSource(new OracleCatalog(restricted), {
        version: 3,
        procedures: [{ owner: 'IAM', name: 'OSP_NOOP' }],
        functions: [{ owner: 'IAM', name: 'OSP_NORMALIZE' }],
      });
      assert.equal(ordinary.programUnits.length, 2);
      await assert.rejects(
        extractSource(new OracleCatalog(restricted), {
          version: 3,
          packages: [{ owner: 'IAM', name: 'OSP_CONSTANTS' }],
        }),
        /PACKAGE_BODY_VISIBILITY/,
      );
      await assert.rejects(
        extractSource(new OracleCatalog(restricted), {
          version: 3,
          packages: [{ owner: 'IAM', name: 'OSP_API' }],
        }),
        /PACKAGE_BODY_VISIBILITY|CATALOG_(?:INCOMPLETE_METADATA|CARDINALITY)/,
      );
      assert.deepEqual(await state(), before);
    } finally {
      await restricted.close();
      await source.close();
    }
  },
);

test(
  'explicit mixed programs round-trip with exact source, sequence reset, aliases, and non-consuming verification',
  { timeout: 240_000 },
  async () => {
    rejectDsnOverrides();
    await compose(['up', '-d', '--wait']);
    const port = (await compose(['port', 'oracle-destination', '1521']))
      .trim()
      .split(':')
      .pop();
    const connection = await oracle.getConnection({
      user: 'system',
      password: process.env.ORACLE_PWD ?? 'OracleDev123',
      connectString: `127.0.0.1:${port}/FREEPDB1`,
    });
    const owner = 'OSP_PROGRAM_TEST';
    const execute = (sql: string) => connection.execute(sql);
    const rows = async (sql: string) =>
      (
        await connection.execute(
          sql,
          {},
          { outFormat: oracle.OUT_FORMAT_OBJECT },
        )
      ).rows;
    try {
      await execute(
        `CREATE USER ${owner} NO AUTHENTICATION DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS`,
      );
      await execute(
        `CREATE SEQUENCE ${owner}.S MINVALUE 1 MAXVALUE 9999999999999999999999999999 START WITH 500 CACHE 20 KEEP`,
      );
      await execute(
        `CREATE SEQUENCE ${owner}.D MINVALUE -99 MAXVALUE -1 INCREMENT BY -2 START WITH -21 NOCACHE NOORDER`,
      );
      await execute(
        `CREATE SEQUENCE ${owner}.CYCLING MINVALUE 1 MAXVALUE 5 INCREMENT BY 2 START WITH 3 NOCACHE CYCLE ORDER`,
      );
      await execute(`CREATE SYNONYM ${owner}.S_ALIAS FOR ${owner}.S`);
      await execute(`CREATE SYNONYM ${owner}.CHAIN FOR ${owner}.S_ALIAS`);
      await execute(
        `CREATE TABLE ${owner}.T (ID NUMBER DEFAULT ${owner}.S.NEXTVAL, VALUE VARCHAR2(100))`,
      );
      await execute(
        `CREATE FUNCTION ${owner}.NORMALIZE(n VARCHAR2) RETURN VARCHAR2 DETERMINISTIC RESULT_CACHE AS BEGIN RETURN UPPER(n); END;`,
      );
      await execute(
        `CREATE INDEX ${owner}.FI ON ${owner}.T (${owner}.NORMALIZE(VALUE))`,
      );
      await execute(
        `CREATE VIEW ${owner}.V AS SELECT ${owner}.NORMALIZE(VALUE) AS VALUE FROM ${owner}.T`,
      );
      await execute(
        `CREATE PROCEDURE ${owner}.P(n OUT NUMBER) AS BEGIN SELECT COUNT(*) INTO n FROM ${owner}.T; END;`,
      );
      await execute(
        `CREATE PACKAGE ${owner}.C AS value CONSTANT NUMBER := 42; END;`,
      );
      await execute(
        `CREATE PACKAGE ${owner}.API AUTHID CURRENT_USER AS PROCEDURE noop; FUNCTION next_id RETURN NUMBER; END;`,
      );
      await execute(
        `CREATE PACKAGE BODY ${owner}.API AS PROCEDURE noop IS BEGIN NULL; END; FUNCTION next_id RETURN NUMBER IS BEGIN RETURN ${owner}.CHAIN.NEXTVAL; END; BEGIN INSERT INTO ${owner}.T(ID,VALUE) VALUES(-1,'init'); END;`,
      );
      await execute(
        `CREATE PROCEDURE ${owner}.LONG_P AS v VARCHAR2(32767) := q'[${'Ω'.repeat(3000)}\n/\nSET DEFINE ON]'; /*${'x'.repeat(35000)}*/ BEGIN NULL; END;`,
      );
      const selection = {
        version: 3 as const,
        tables: [{ owner, name: 'T' }],
        views: [{ owner, name: 'V' }],
        procedures: [
          { owner, name: 'P' },
          { owner, name: 'LONG_P' },
          { owner, package: 'API', name: 'NOOP' },
        ],
        functions: [
          { owner, name: 'NORMALIZE' },
          { owner, package: 'API', name: 'NEXT_ID' },
        ],
        packages: [{ owner, name: 'C' }],
        sequences: [
          { owner, name: 'S' },
          { owner, name: 'D' },
          { owner, name: 'CYCLING' },
        ],
        synonyms: [
          { owner, name: 'S_ALIAS' },
          { owner, name: 'CHAIN' },
        ],
      };
      const before = await rows(
        `SELECT last_number FROM dba_sequences WHERE sequence_owner='${owner}' AND sequence_name='S'`,
      );
      const source = await extractSource(
        new OracleCatalog(connection, 'dba'),
        selection,
      );
      await assert.rejects(
        extractSource(new OracleCatalog(connection, 'all'), {
          version: 3,
          packages: [{ owner, name: 'C' }],
        }),
        /PACKAGE_BODY_VISIBILITY/,
      );
      const narrow = await extractSource(
        new OracleCatalog(connection, 'dba', undefined, 1),
        selection,
      );
      assert.deepEqual(
        { ...source, extractedAt: '' },
        { ...narrow, extractedAt: '' },
      );
      assert.deepEqual(
        await rows(
          `SELECT last_number FROM dba_sequences WHERE sequence_owner='${owner}' AND sequence_name='S'`,
        ),
        before,
      );
      assert.equal(
        source.programUnits.find((unit) => unit.reference.name === 'C')
          ?.packageBodyPresent,
        false,
      );
      assert.equal(
        source.programUnits.filter((unit) => unit.reference.name === 'API')
          .length,
        2,
      );
      const original = structuredClone(source);
      const target = transformSource(
        source,
        policySchema.parse({
          version: 2,
          sequenceStarts: [
            { reference: { owner, name: 'D' }, startWith: '-11' },
          ],
        }),
      );
      const sql = generateSql(target);
      assert.deepEqual(source, original);
      assert.ok(sql.indexOf('CREATE SEQUENCE') < sql.indexOf('CREATE TABLE'));
      assert.ok(
        sql.indexOf('-- Compile FUNCTION') < sql.indexOf('CREATE INDEX'),
      );
      assert.ok(!verificationChecks(target).includes('NEXTVAL'));
      await execute(`DROP USER ${owner} CASCADE`);
      const output = await compose(
        [
          'exec',
          '-T',
          '-e',
          'NLS_LANG=.AL32UTF8',
          'oracle-destination',
          'sqlplus',
          '-s',
          '/ as sysdba',
        ],
        sqlSession(generatedReplay(sql) + '\n' + verificationChecks(target)),
      );
      assert.ok(!/ORA-\d|SP2-\d/.test(output), output);
      const wrongSequence = structuredClone(target);
      wrongSequence.sequences[0].incrementBy = '99';
      await assert.rejects(
        compose(
          [
            'exec',
            '-T',
            '-e',
            'NLS_LANG=.AL32UTF8',
            'oracle-destination',
            'sqlplus',
            '-s',
            '/ as sysdba',
          ],
          sqlSession(verificationChecks(wrongSequence)),
        ),
        /OBJECT_RECONSTRUCTION_FAILED/,
      );
      const wrongAlias = structuredClone(target);
      wrongAlias.synonyms[0].target.name = 'D';
      await assert.rejects(
        compose(
          [
            'exec',
            '-T',
            '-e',
            'NLS_LANG=.AL32UTF8',
            'oracle-destination',
            'sqlplus',
            '-s',
            '/ as sysdba',
          ],
          sqlSession(verificationChecks(wrongAlias)),
        ),
        /OBJECT_RECONSTRUCTION_FAILED/,
      );
      const captured = await extractSource(
        new OracleCatalog(connection, 'dba'),
        selection,
      );
      for (const unit of source.programUnits) {
        const actual = captured.programUnits.find(
          (item) =>
            item.type === unit.type &&
            item.reference.name === unit.reference.name,
        )!;
        // Oracle blanks the qualified owner in the header. The body must remain exact.
        assert.equal(
          actual.sourceLines
            .map((line) => line.text)
            .join('')
            .slice(actual.sourceLines[0].text.indexOf(' AS')),
          unit.sourceLines
            .map((line) => line.text)
            .join('')
            .slice(unit.sourceLines[0].text.indexOf(' AS')),
        );
      }
      assert.deepEqual(
        await rows(
          `SELECT min_value,increment_by,keep_value FROM dba_sequences WHERE sequence_owner='${owner}' AND sequence_name='S'`,
        ),
        [{ MIN_VALUE: 1, INCREMENT_BY: 1, KEEP_VALUE: 'Y' }],
      );
      assert.deepEqual(await rows(`SELECT COUNT(*) AS N FROM ${owner}.T`), [
        { N: 0 },
      ]);
      // Invoke only as an isolated application proxy session, never operational checks.
      await execute(`GRANT CREATE SESSION TO ${owner}`);
      await execute(`ALTER USER ${owner} GRANT CONNECT THROUGH SYSTEM`);
      const application = await oracle.getConnection({
        user: `system[${owner}]`,
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${port}/FREEPDB1`,
      });
      try {
        await application.execute(
          `CREATE INDEX ${owner}.APP_FI ON ${owner}.T (${owner}.NORMALIZE(ID))`,
        );
        assert.deepEqual(
          (
            await application.execute(
              `SELECT ${owner}.S.NEXTVAL AS N FROM dual`,
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows,
          [{ N: 1 }],
        );
        assert.deepEqual(
          (
            await application.execute(
              `SELECT ${owner}.D.NEXTVAL AS N FROM dual`,
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows,
          [{ N: -11 }],
        );
        assert.deepEqual(
          (
            await application.execute(
              `SELECT ${owner}.D.NEXTVAL AS N FROM dual`,
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows,
          [{ N: -13 }],
        );
        for (const n of [1, 3, 5, 1])
          assert.deepEqual(
            (
              await application.execute(
                `SELECT ${owner}.CYCLING.NEXTVAL AS N FROM dual`,
                {},
                { outFormat: oracle.OUT_FORMAT_OBJECT },
              )
            ).rows,
            [{ N: n }],
          );
        const called = await application.execute(
          `BEGIN :n := ${owner}.API.next_id; END;`,
          { n: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
        );
        assert.deepEqual(called.outBinds, { n: 2 });
        assert.deepEqual(
          (
            await application.execute(
              `SELECT COUNT(*) AS N FROM ${owner}.T`,
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows,
          [{ N: 1 }],
        );
        await application.rollback();
        assert.deepEqual(
          (
            await application.execute(
              `SELECT ${owner}.NORMALIZE('abc') AS N FROM dual`,
              {},
              { outFormat: oracle.OUT_FORMAT_OBJECT },
            )
          ).rows,
          [{ N: 'ABC' }],
        );
      } finally {
        await application.close();
      }
      // Compiler settings must be restored even after DDL compilation fails.
      const settingsSql =
        "SELECT name,value FROM v$parameter WHERE name IN ('plsql_optimize_level','plsql_debug','plsql_ccflags','plsql_warnings','plsql_implicit_conversion_bool') ORDER BY name";
      const sessionSettings = await rows(settingsSql);
      const invalid = program('BROKEN');
      invalid.reference.owner = owner;
      invalid.sourceLines[0].text =
        'PROCEDURE BROKEN AS BEGIN definitely_missing_call; END;';
      invalid.compilerSettings.plsqlCcflags = 'probe:42';
      invalid.compilerSettings.plsqlDebug = true;
      const wrapper = renderProgram(invalid).split('\n/')[0];
      await assert.rejects(execute(wrapper), /PROGRAM_COMPILATION_FAILED/);
      assert.deepEqual(await rows(settingsSql), sessionSettings);
      // Definer-rights compilation cannot substitute role membership for a direct grant.
      const reader = 'OSP_PROGRAM_READER',
        role = 'OSP_PROGRAM_ROLE';
      await execute(`CREATE USER ${reader} NO AUTHENTICATION`);
      await execute(`CREATE ROLE ${role}`);
      try {
        await execute(`GRANT SELECT ON ${owner}.T TO ${role}`);
        await execute(`GRANT ${role} TO ${reader}`);
        const consumer = program('READ_T');
        consumer.reference.owner = reader;
        consumer.sourceLines[0].text = `PROCEDURE READ_T(n OUT NUMBER) AS BEGIN SELECT COUNT(*) INTO n FROM ${owner}.T; END;`;
        const compile = renderProgram(consumer).split('\n/')[0];
        await assert.rejects(execute(compile), /PROGRAM_COMPILATION_FAILED/);
        await execute(`GRANT SELECT ON ${owner}.T TO ${reader}`);
        await execute(`DROP PROCEDURE ${reader}.READ_T`);
        await execute(compile);
        assert.deepEqual(
          await rows(
            `SELECT status FROM dba_objects WHERE owner='${reader}' AND object_name='READ_T' AND object_type='PROCEDURE'`,
          ),
          [{ STATUS: 'VALID' }],
        );
      } finally {
        await execute(`DROP USER ${reader} CASCADE`);
        await execute(`DROP ROLE ${role}`);
      }
    } finally {
      try {
        await execute(`DROP USER ${owner} CASCADE`);
      } finally {
        await connection.close();
      }
    }
  },
);
