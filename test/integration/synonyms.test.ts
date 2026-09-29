import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import oracle from 'oracledb';
import { testComposeArgs, rejectDsnOverrides } from '../scripts/compose.js';
import { childEnvironment, runProcess } from '../../scripts/process.js';
import { OracleCatalog } from '../../src/catalog.js';
import { extractSource } from '../../src/extract.js';
import { transformSource } from '../../src/transform.js';
import { generateSql } from '../../src/generate.js';
import { validateTarget } from '../../src/validate.js';
import { policySchema } from '../../src/model.js';
import {
  generatedReplay,
  setupChecks,
  verificationChecks,
  sqlSession,
} from '../../scripts/compose-destination.js';

test(
  'private/public aliases reconstruct local chains and program consumers on Oracle',
  { timeout: 180_000 },
  async () => {
    rejectDsnOverrides();
    const command = async (args: string[], input?: string) => {
      const codes = new Set<string>();
      try {
        return await runProcess('docker', [...testComposeArgs, ...args], {
          env: childEnvironment(),
          input,
          timeoutMs: 120_000,
          onProgressLine: ({ line }) => {
            for (const code of line.match(/(?:ORA|SP2)-[0-9]+/g) ?? [])
              codes.add(code);
          },
        });
      } catch {
        throw new Error(`Oracle synonym test failed: ${[...codes].join(', ')}`);
      }
    };
    const connect = async (service: string) => {
      const published = await command(['port', service, '1521']);
      return oracle.getConnection({
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString: `127.0.0.1:${/:(\d+)\s*$/.exec(published)![1]}/FREEPDB1`,
      });
    };
    const source = await connect('oracle-source');
    const destination = await connect('oracle-destination');
    const replay = (sql: string) =>
      command(
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
        sqlSession(sql),
      );
    const owner = 'SY_APP',
      reader = 'SY_READER',
      publicName = 'OSP_SY_PUBLIC_P';
    const ref = (name: string, schema = owner) => ({ owner: schema, name });
    const cleanup = async (connection: oracle.Connection) => {
      await connection.execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP PUBLIC SYNONYM ${publicName}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1432 THEN RAISE; END IF; END;`,
      );
      for (const schema of [reader, owner])
        await connection.execute(
          `BEGIN EXECUTE IMMEDIATE 'DROP USER ${schema} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;`,
        );
    };
    try {
      await cleanup(source);
      await cleanup(destination);
      const password = randomBytes(20).toString('hex');
      await source.execute(
        `CREATE USER ${owner} IDENTIFIED BY "${password}" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS`,
      );
      await source.execute(`CREATE USER ${reader} IDENTIFIED BY "${password}"`);
      await source.execute(`GRANT CREATE SESSION TO ${owner}, ${reader}`);
      for (const sql of [
        `CREATE TABLE ${owner}.T (ID NUMBER)`,
        `CREATE SEQUENCE ${owner}.S START WITH 500 NOCACHE`,
        `CREATE FUNCTION ${owner}.F(x NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN x+1; END;`,
        `CREATE PROCEDURE ${owner}.P AS BEGIN NULL; END;`,
        `CREATE PACKAGE ${owner}.API AS FUNCTION ONE RETURN NUMBER; END;`,
        `CREATE PACKAGE BODY ${owner}.API AS FUNCTION ONE RETURN NUMBER AS BEGIN RETURN 1; END; END;`,
        `CREATE SYNONYM ${owner}.T_ALIAS FOR ${owner}.T`,
        `CREATE SYNONYM ${owner}.T_CHAIN FOR ${owner}.T_ALIAS`,
        `CREATE SYNONYM ${owner}.S_ALIAS FOR ${owner}.S`,
        `CREATE SYNONYM ${owner}.F_ALIAS FOR ${owner}.F`,
        `CREATE SYNONYM ${owner}.P_ALIAS FOR ${owner}.P`,
        `CREATE SYNONYM ${owner}.API_ALIAS FOR ${owner}.API`,
        `CREATE PUBLIC SYNONYM ${publicName} FOR ${owner}.P`,
        `CREATE VIEW ${owner}.V AS SELECT ID FROM ${owner}.T_CHAIN`,
        `CREATE SYNONYM ${owner}.PUBLIC_CHAIN FOR ${owner}.${publicName}`,
        `CREATE SYNONYM ${owner}.V_ALIAS FOR ${owner}.V`,
        `CREATE SYNONYM ${owner}."Odd é" FOR ${owner}.T`,
        `CREATE TABLE ${owner}.DEFAULT_T (ID NUMBER DEFAULT ${owner}.S_ALIAS.NEXTVAL)`,
        `CREATE INDEX ${owner}.F_IDX ON ${owner}.T (${owner}.F_ALIAS(ID))`,
        `CREATE FUNCTION ${owner}.READ_ALIAS RETURN NUMBER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM T_CHAIN; RETURN n + API_ALIAS.ONE; END;`,
        `CREATE PROCEDURE ${owner}.CALL_ALIAS AS BEGIN P_ALIAS; ${publicName}; END;`,
        `CREATE SYNONYM ${owner}.DANGLING FOR ${owner}.ABSENT`,
        `CREATE SYNONYM ${owner}.LOOP_A FOR ${owner}.LOOP_B`,
        `CREATE SYNONYM ${owner}.LOOP_B FOR ${owner}.LOOP_A`,
        `CREATE SYNONYM ${owner}.REMOTE_ALIAS FOR OTHER.T@NOT_A_REAL_LINK`,
        `CREATE SYNONYM ${owner}.REMOTE_CHAIN FOR ${owner}.REMOTE_ALIAS`,
      ])
        await source.execute(sql);
      const catalog = new OracleCatalog(source, 'dba');
      for (const [name, code] of [
        ['DANGLING', 'UNRESOLVED_SYNONYM_TARGET'],
        ['LOOP_A', 'SYNONYM_CYCLE'],
        ['REMOTE_ALIAS', 'UNSUPPORTED_SYNONYM'],
        ['REMOTE_CHAIN', 'UNSUPPORTED_SYNONYM'],
      ] as const)
        await assert.rejects(catalog.synonym(ref(name)), new RegExp(code));
      await source.execute(
        `CREATE SYNONYM ${reader}.HIDDEN_ALIAS FOR ${owner}.T`,
      );
      const hidden = await oracle.getConnection({
        user: reader,
        password,
        connectString: source.connectString,
      });
      try {
        await assert.rejects(
          new OracleCatalog(hidden).synonym(ref('T_ALIAS')),
          /SYNONYM_METADATA_UNAVAILABLE/,
        );
        await assert.rejects(
          new OracleCatalog(hidden).synonym(ref('HIDDEN_ALIAS', reader)),
          /UNRESOLVED_SYNONYM_TARGET/,
        );
      } finally {
        await hidden.close();
      }
      const synonyms = [
        'T_ALIAS',
        'T_CHAIN',
        'S_ALIAS',
        'F_ALIAS',
        'P_ALIAS',
        'API_ALIAS',
        'V_ALIAS',
        'Odd é',
        'PUBLIC_CHAIN',
      ].map((name) => ref(name));
      synonyms.push(ref(publicName, 'PUBLIC'));
      const owned = await oracle.getConnection({
        user: owner,
        password,
        connectString: source.connectString,
      });
      try {
        assert.equal(
          (await new OracleCatalog(owned).synonym(ref('T_CHAIN'))).resolution
            .length,
          2,
        );
      } finally {
        await owned.close();
      }
      const aliasOnly = await extractSource(catalog, {
        version: 2,
        synonyms: [ref('T_CHAIN')],
      });
      assert.equal(aliasOnly.tables.length, 0);
      assert.equal(aliasOnly.synonyms.length, 1);
      const extracted = await extractSource(catalog, {
        version: 2,
        synonyms,
        tables: [ref('T'), ref('DEFAULT_T')],
        views: [ref('V')],
        sequences: [ref('S')],
        functions: [ref('F'), ref('READ_ALIAS')],
        procedures: [ref('P'), ref('CALL_ALIAS')],
        packages: [ref('API')],
      });
      assert.equal(
        extracted.synonyms.find((s) => s.reference.name === 'PUBLIC_CHAIN')!
          .resolution[0].reference.owner,
        'PUBLIC',
      );
      const target = transformSource(extracted, policySchema.parse({}));
      assert.deepEqual(
        validateTarget(target).filter((d) => d.severity === 'error'),
        [],
      );
      const sql = generateSql(target);
      await replay(generatedReplay(sql));
      await replay(verificationChecks(target));
      // An external intermediate alias can remain INVALID after its target is created.
      // Setup must check the mapping, not reject that harmless transient status.
      for (const connection of [source, destination]) {
        await connection.execute(
          `CREATE SYNONYM ${owner}.EXTERNAL_A FOR ${owner}.EXTERNAL_T`,
        );
        await connection.execute(
          `CREATE TABLE ${owner}.EXTERNAL_T (ID NUMBER)`,
        );
      }
      await source.execute(
        `CREATE SYNONYM ${owner}.EXTERNAL_CHAIN FOR ${owner}.EXTERNAL_A`,
      );
      const external = transformSource(
        await extractSource(catalog, {
          version: 2,
          synonyms: [ref('EXTERNAL_CHAIN')],
        }),
        policySchema.parse({
          createSchemas: false,
          externalPrerequisites: [
            { reference: ref('EXTERNAL_A'), type: 'SYNONYM' },
            { reference: ref('EXTERNAL_T'), type: 'TABLE' },
          ],
        }),
      );
      assert.deepEqual(
        (
          await destination.execute(
            `SELECT status FROM dba_objects WHERE owner='${owner}' AND object_name='EXTERNAL_A' AND object_type='SYNONYM'`,
          )
        ).rows,
        [['INVALID']],
      );
      await replay(setupChecks(external));
      await replay(generatedReplay(generateSql(external)));
      await replay(verificationChecks(external));
      // Behavioral probes run only on the disposable destination.
      assert.deepEqual(
        (
          await destination.execute(
            `SELECT ${owner}.F_ALIAS(2), ${owner}.API_ALIAS.ONE, ${owner}.READ_ALIAS FROM dual`,
          )
        ).rows,
        [[3, 1, 1]],
      );
      await destination.execute(`BEGIN ${owner}.CALL_ALIAS; END;`);
      await destination.execute(
        `INSERT INTO ${owner}.DEFAULT_T (ID) VALUES (DEFAULT)`,
      );
      assert.deepEqual(
        (await destination.execute(`SELECT ID FROM ${owner}.DEFAULT_T`)).rows,
        [[1]],
      );
      assert.deepEqual(
        (
          await source.execute(
            `SELECT last_number FROM all_sequences WHERE sequence_owner='${owner}' AND sequence_name='S'`,
          )
        ).rows,
        [[500]],
      );
      // Exact mapping verification catches a valid alias redirected to the wrong object.
      await destination.execute(
        `CREATE OR REPLACE SYNONYM ${owner}.T_ALIAS FOR ${owner}.DEFAULT_T`,
      );
      await assert.rejects(replay(verificationChecks(target)), /ORA-20001/);
      await destination.execute(
        `CREATE OR REPLACE SYNONYM ${owner}.T_ALIAS FOR ${owner}.T`,
      );
      // Existing names cannot silently be replaced by replay.
      await assert.rejects(replay(generatedReplay(sql)), /ORA-00955/);
      // Cross-owner access remains an explicit prerequisite, even through an alias.
      await source.execute(`GRANT SELECT ON ${owner}.T TO ${reader}`);
      await source.execute(`CREATE SYNONYM ${reader}.T_ALIAS FOR ${owner}.T`);
      await source.execute(
        `CREATE FUNCTION ${reader}.READ_T RETURN NUMBER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM T_ALIAS; RETURN n; END;`,
      );
      const cross = await extractSource(catalog, {
        version: 2,
        synonyms: [ref('T_ALIAS', reader)],
        functions: [ref('READ_T', reader)],
      });
      const crossTarget = transformSource(
        cross,
        policySchema.parse({
          createSchemas: false,
          externalPrerequisites: [{ reference: ref('T'), type: 'TABLE' }],
        }),
      );
      assert.deepEqual(
        validateTarget(crossTarget).filter((d) => d.severity === 'error'),
        [],
      );
      await destination.execute(`CREATE USER ${reader} NO AUTHENTICATION`);
      await assert.rejects(
        replay(generatedReplay(generateSql(crossTarget))),
        /ORA-20001|ORA-00942/,
      );
      await destination.execute(`DROP USER ${reader} CASCADE`);
      await destination.execute(`CREATE USER ${reader} NO AUTHENTICATION`);
      await destination.execute(`GRANT SELECT ON ${owner}.T TO ${reader}`);
      await replay(generatedReplay(generateSql(crossTarget)));
      await replay(verificationChecks(crossTarget));
    } finally {
      await cleanup(source);
      await cleanup(destination);
      await source.close();
      await destination.close();
    }
  },
);
