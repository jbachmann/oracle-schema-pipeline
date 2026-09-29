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
import { policySchema, type ObjectSelection } from '../../src/model.js';
import {
  generatedReplay,
  verificationChecks,
  sqlSession,
} from '../../scripts/compose-destination.js';

// Independent fixtures live only in the explicitly named test Compose databases.
test(
  'program metadata, privileges, full CLOBs, sequence reset and compilation on Oracle',
  { timeout: 180_000 },
  async () => {
    rejectDsnOverrides();
    const codes: string[] = [];
    const command = async (args: string[], input?: string) => {
      codes.length = 0;
      try {
        return await runProcess('docker', [...testComposeArgs, ...args], {
          env: childEnvironment(),
          input,
          timeoutMs: 120_000,
          onProgressLine: ({ line }) => {
            codes.push(...(line.match(/(?:ORA|SP2)-[0-9]+/g) ?? []));
            if (line.startsWith('ORA-20001: OSP_PROGRAM_INVALID'))
              codes.push(line);
          },
        });
      } catch {
        throw new Error(
          `Oracle test command failed: ${[...new Set(codes)].join(', ')}`,
        );
      }
    };
    const dsn = async (service: string) => {
      const result = await command(['port', service, '1521']);
      const port = /:(\d+)\s*$/.exec(result)?.[1];
      assert.ok(port);
      return `127.0.0.1:${port}/FREEPDB1`;
    };
    const sourceDsn = await dsn('oracle-source');
    const destinationDsn = await dsn('oracle-destination');
    const connect = (connectString: string) =>
      oracle.getConnection({
        user: 'SYSTEM',
        password: process.env.ORACLE_PWD ?? 'OracleDev123',
        connectString,
      });
    const source = await connect(sourceDsn),
      destination = await connect(destinationDsn);
    const owner = 'PS_APP',
      reader = 'PS_READER';
    const password = randomBytes(20).toString('hex');
    const drop = async (connection: oracle.Connection, name: string) => {
      await connection.execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP USER ${name} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;`,
      );
    };
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
    const reference = (name: string) => ({ owner, name });
    try {
      await drop(source, owner);
      await drop(source, reader);
      await drop(destination, owner);
      await source.execute(
        `CREATE USER ${owner} IDENTIFIED BY "${password}" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS`,
      );
      await source.execute(`CREATE USER ${reader} IDENTIFIED BY "${password}"`);
      await source.execute(`GRANT CREATE SESSION TO ${owner}, ${reader}`);
      await source.execute(
        `CREATE SEQUENCE ${owner}.COUNTER_SEQ MINVALUE 1 MAXVALUE 999999 START WITH 500 NOCACHE`,
      );
      await source.execute(
        `CREATE SEQUENCE ${owner}.DESC_SEQ MINVALUE -999999 MAXVALUE -1 START WITH -500 INCREMENT BY -3 NOCACHE CYCLE ORDER`,
      );
      await source.execute(
        `CREATE SEQUENCE ${owner}.BIG_SEQ MINVALUE 1 MAXVALUE 9999999999999999999999999999 NOCACHE`,
      );
      await source.execute(
        `CREATE SEQUENCE ${owner}.SCALE_SEQ SCALE EXTEND KEEP`,
      );
      await source.execute(`CREATE SEQUENCE ${owner}.SESSION_SEQ SESSION`);
      await source.execute(
        `CREATE SEQUENCE ${owner}.CYCLE_SEQ MINVALUE 1 MAXVALUE 10 INCREMENT BY 3 CACHE 3 CYCLE`,
      );
      await source.execute(
        `CREATE SEQUENCE ${owner}.BOUND_SEQ MINVALUE 1 MAXVALUE 2 NOCACHE`,
      );
      await source.execute(
        `CREATE PACKAGE ${owner}.COUNTER_API AS FUNCTION NEXT_ID RETURN NUMBER; END;`,
      );
      await source.execute(
        `CREATE PACKAGE BODY ${owner}.COUNTER_API AS FUNCTION NEXT_ID RETURN NUMBER IS BEGIN RETURN ${owner}.COUNTER_SEQ.NEXTVAL; END; END;`,
      );
      await source.execute(
        `CREATE PACKAGE ${owner}.SPEC_ONLY AS answer CONSTANT NUMBER := 1; END;`,
      );
      await source.execute(
        `CREATE FUNCTION ${owner}.ONE RETURN NUMBER DETERMINISTIC AS BEGIN RETURN 1; END;`,
      );
      await source.execute(
        `CREATE PROCEDURE ${owner}.PING AS\n${'-- Unicode é; slash / and blank lines\n\n'.repeat(1400)}BEGIN NULL; END;`,
      );
      await source.execute(
        `CREATE PROCEDURE ${owner}.BAD AS BEGIN unavailable_procedure; END;`,
      );
      await source.execute(
        `CREATE TABLE ${owner}.ITEMS (id NUMBER DEFAULT ${owner}.COUNTER_SEQ.NEXTVAL PRIMARY KEY, value NUMBER)`,
      );
      await source.execute(
        `CREATE FUNCTION ${owner}.READ_ITEMS RETURN NUMBER DETERMINISTIC AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${owner}.ITEMS; RETURN n; END;`,
      );
      await source.execute(
        `CREATE INDEX ${owner}.ITEMS_IX ON ${owner}.ITEMS (${owner}.READ_ITEMS() + value)`,
      );
      await source.execute(
        `CREATE VIEW ${owner}.ITEM_VIEW AS SELECT ${owner}.ONE() AS one FROM ${owner}.ITEMS`,
      );
      await source.execute(
        `GRANT EXECUTE ON ${owner}.COUNTER_API TO ${reader}`,
      );
      for (const name of ['CYCLE_A', 'CYCLE_B'])
        await source.execute(
          `CREATE PACKAGE ${owner}.${name} AS FUNCTION ONE RETURN NUMBER; END;`,
        );
      await source.execute(
        `CREATE PACKAGE BODY ${owner}.CYCLE_A AS FUNCTION ONE RETURN NUMBER AS BEGIN RETURN ${owner}.CYCLE_B.ONE(); END; END;`,
      );
      await source.execute(
        `CREATE PACKAGE BODY ${owner}.CYCLE_B AS FUNCTION ONE RETURN NUMBER AS BEGIN IF 1=1 THEN RETURN 1; ELSE RETURN ${owner}.CYCLE_A.ONE(); END IF; END; END;`,
      );
      await source.execute(
        `CREATE PACKAGE ${owner}.VIEW_API AS FUNCTION ONE RETURN NUMBER; END;`,
      );
      await source.execute(
        `CREATE PACKAGE BODY ${owner}.VIEW_API AS FUNCTION ONE RETURN NUMBER AS BEGIN RETURN 1; END; END;`,
      );
      await source.execute(
        `CREATE VIEW ${owner}.CYCLE_VIEW AS SELECT ${owner}.VIEW_API.ONE() AS ONE FROM ${owner}.ITEMS`,
      );
      await source.execute(
        `CREATE OR REPLACE PACKAGE BODY ${owner}.VIEW_API AS FUNCTION ONE RETURN NUMBER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${owner}.CYCLE_VIEW; RETURN n; END; END;`,
      );
      await source.execute(`GRANT EXECUTE ON ${owner}.ONE TO ${reader}`);
      await source.execute(
        `CREATE TABLE ${reader}.VIRTUAL_ITEMS (VALUE NUMBER, COMPUTED NUMBER GENERATED ALWAYS AS (${owner}.ONE() + VALUE) VIRTUAL)`,
      );
      const selection: ObjectSelection = {
        version: 2,
        tables: [reference('ITEMS'), { owner: reader, name: 'VIRTUAL_ITEMS' }],
        views: [reference('ITEM_VIEW'), reference('CYCLE_VIEW')],
        packages: [
          'COUNTER_API',
          'SPEC_ONLY',
          'CYCLE_A',
          'CYCLE_B',
          'VIEW_API',
        ].map(reference),
        procedures: [reference('PING')],
        functions: ['ONE', 'READ_ITEMS'].map(reference),
        sequences: [
          'COUNTER_SEQ',
          'DESC_SEQ',
          'BIG_SEQ',
          'SCALE_SEQ',
          'SESSION_SEQ',
          'CYCLE_SEQ',
          'BOUND_SEQ',
        ].map(reference),
      };
      const catalog = new OracleCatalog(source, 'dba');
      const extracted = await extractSource(catalog, selection);
      assert.ok(
        extracted.programs.find((p) => p.kind === 'PROCEDURE')!.units[0].ddl
          .length > 32768,
      );
      assert.equal(
        extracted.programs.find((p) => p.reference.name === 'SPEC_ONLY')!.units
          .length,
        1,
      );
      const restricted = await oracle.getConnection({
        user: reader,
        password,
        connectString: sourceDsn,
      });
      const owning = await oracle.getConnection({
        user: owner,
        password,
        connectString: sourceDsn,
      });
      try {
        await assert.rejects(
          new OracleCatalog(restricted).program(
            reference('COUNTER_API'),
            'PACKAGE',
          ),
          /PROGRAM_METADATA_UNAVAILABLE/,
        );
        const owned = await new OracleCatalog(owning).program(
          reference('COUNTER_API'),
          'PACKAGE',
        );
        assert.deepEqual(
          owned,
          extracted.programs.find((p) => p.reference.name === 'COUNTER_API'),
        );
        await source.execute(`GRANT SELECT_CATALOG_ROLE TO ${reader}`);
        // New login enables the newly granted catalog role, without broadening old fixture readers.
        const authorized = await oracle.getConnection({
          user: reader,
          password,
          connectString: sourceDsn,
        });
        try {
          const crossOwner = await new OracleCatalog(authorized, 'dba').program(
            reference('COUNTER_API'),
            'PACKAGE',
          );
          assert.deepEqual(crossOwner, owned);
          await assert.rejects(
            new OracleCatalog(authorized, 'all').program(
              reference('COUNTER_API'),
              'PACKAGE',
            ),
            /catalog scope dba/,
          );
        } finally {
          await authorized.close();
        }
      } finally {
        await restricted.close();
        await owning.close();
      }
      const target = transformSource(extracted, policySchema.parse({}));
      assert.deepEqual(
        validateTarget(target).filter((d) => d.severity === 'error'),
        [],
      );
      // Oracle omits this virtual-column relationship from ALL_DEPENDENCIES.
      // Without an explicit fact the replay must fail, never claim completion.
      assert.equal(
        target.prerequisites.some(
          (p) => p.requiredBy.owner === reader && p.reference.name === 'ONE',
        ),
        false,
      );
      await assert.rejects(replay(generatedReplay(generateSql(target))));
      await drop(destination, reader);
      await drop(destination, owner);
      // Independently known fixture fact tests offline ordering/grant derivation;
      // extraction must not guess this relationship by parsing opaque SQL text.
      target.prerequisites.push({
        requiredBy: { owner: reader, name: 'VIRTUAL_ITEMS' },
        reference: reference('ONE'),
        type: 'FUNCTION',
        databaseLink: null,
        origin: 'TABLE',
      });
      const sql = generateSql(target);
      for (const program of extracted.programs)
        for (const unit of program.units) assert.ok(sql.includes(unit.ddl));
      await replay(generatedReplay(sql));
      await replay(verificationChecks(target));
      const rows = async (connection: oracle.Connection, sql: string) =>
        (
          await connection.execute(
            sql,
            {},
            { outFormat: oracle.OUT_FORMAT_OBJECT },
          )
        ).rows;
      const sourceText = `SELECT name, type, line, text FROM all_source WHERE owner='${owner}' AND name<>'BAD' ORDER BY name,type,line`;
      const sourceRows = (await rows(source, sourceText)) as {
        NAME: string;
        TYPE: string;
        LINE: number;
        TEXT: string;
      }[];
      const destinationRows = (await rows(
        destination,
        sourceText,
      )) as typeof sourceRows;
      assert.equal(destinationRows.length, sourceRows.length);
      for (let i = 0; i < sourceRows.length; i++) {
        // GET_DDL quotes and aligns the declaration identity; the remainder is opaque.
        const normalize = (row: (typeof sourceRows)[number]) =>
          row.LINE === 1
            ? row.TEXT.replace(
                new RegExp(`^${row.TYPE}\\s+"?${row.NAME}"?`),
                row.TYPE + ' ' + row.NAME,
              )
            : row.TEXT;
        assert.equal(
          normalize(destinationRows[i]),
          normalize(sourceRows[i]),
          `Source line ${i}`,
        );
      }
      assert.deepEqual(
        await rows(
          destination,
          `SELECT status, funcidx_status FROM all_indexes WHERE owner='${owner}' AND index_name='ITEMS_IX'`,
        ),
        [{ STATUS: 'VALID', FUNCIDX_STATUS: 'ENABLED' }],
      );
      const sequenceFacts = `SELECT sequence_name, to_char(min_value) min_value, to_char(max_value) max_value, to_char(increment_by) increment_by, cache_size, cycle_flag, order_flag, scale_flag, extend_flag, sharded_flag, session_flag, keep_value FROM all_sequences WHERE sequence_owner='${owner}' ORDER BY sequence_name`;
      assert.deepEqual(
        await rows(destination, sequenceFacts),
        await rows(source, sequenceFacts),
      );
      assert.deepEqual(
        await rows(destination, `SELECT ${owner}.ONE() AS N FROM dual`),
        [{ N: 1 }],
      );
      assert.deepEqual(
        await rows(
          destination,
          `SELECT ${owner}.COUNTER_API.NEXT_ID() AS N FROM dual`,
        ),
        [{ N: 1 }],
      );
      assert.deepEqual(
        await rows(
          destination,
          `SELECT ${owner}.DESC_SEQ.NEXTVAL AS N FROM dual`,
        ),
        [{ N: -1 }],
      );
      assert.deepEqual(
        await rows(
          source,
          `SELECT last_number AS N FROM all_sequences WHERE sequence_owner='${owner}' AND sequence_name='COUNTER_SEQ'`,
        ),
        [{ N: 500 }],
      );
      // Cross-owner catalog dependencies do not reveal the required DML privilege.
      await source.execute(`ALTER USER ${reader} QUOTA UNLIMITED ON USERS`);
      await source.execute(`CREATE TABLE ${reader}.EXTERNAL_DATA (N NUMBER)`);
      await source.execute(
        `GRANT SELECT ON ${reader}.EXTERNAL_DATA TO ${owner}`,
      );
      await source.execute(
        `CREATE FUNCTION ${owner}.READ_EXTERNAL RETURN NUMBER AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${reader}.EXTERNAL_DATA; RETURN n; END;`,
      );
      const crossSource = await extractSource(catalog, {
        version: 2,
        functions: [reference('READ_EXTERNAL')],
      });
      assert.ok(
        validateTarget(
          transformSource(crossSource, policySchema.parse({})),
        ).some((d) => d.code === 'UNACKNOWLEDGED_PREREQUISITE'),
      );
      const crossTarget = transformSource(
        crossSource,
        policySchema.parse({
          createSchemas: false,
          externalPrerequisites: [
            {
              reference: { owner: reader, name: 'EXTERNAL_DATA' },
              type: 'TABLE',
            },
          ],
        }),
      );
      await drop(destination, reader);
      await destination.execute(
        `CREATE USER ${reader} NO AUTHENTICATION QUOTA UNLIMITED ON USERS`,
      );
      await destination.execute(
        `CREATE TABLE ${reader}.EXTERNAL_DATA (N NUMBER)`,
      );
      await assert.rejects(replay(generatedReplay(generateSql(crossTarget))));
      await destination.execute(
        `GRANT SELECT ON ${reader}.EXTERNAL_DATA TO ${owner}`,
      );
      await replay(generatedReplay(generateSql(crossTarget)));
      assert.deepEqual(
        await rows(
          destination,
          `SELECT ${owner}.READ_EXTERNAL() AS N FROM dual`,
        ),
        [{ N: 0 }],
      );
      const bad = transformSource(
        await extractSource(catalog, {
          version: 2,
          procedures: [reference('BAD')],
        }),
        policySchema.parse({}),
      );
      await assert.rejects(replay(generatedReplay(generateSql(bad))));
      assert.deepEqual(
        await rows(
          destination,
          `SELECT status FROM all_objects WHERE owner='${owner}' AND object_name='BAD'`,
        ),
        [{ STATUS: 'INVALID' }],
      );
    } finally {
      await drop(source, reader);
      await drop(source, owner);
      await drop(destination, owner);
      await drop(destination, reader);
      await source.close();
      await destination.close();
    }
  },
);
