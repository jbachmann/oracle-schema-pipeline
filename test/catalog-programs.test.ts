import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { extractSource } from '../src/extract.js';

function transport(
  mutate: (
    sql: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[] = (_, rows) => rows,
) {
  let opens = 0,
    closes = 0;
  const statements: string[] = [];
  const connection = {
    async execute(sql: string) {
      assert.match(sql, /^(?:SELECT|WITH)\b/);
      statements.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("table_name='ALL_PLSQL_OBJECT_SETTINGS'"))
        rows = [
          {
            TABLE_NAME: 'ALL_PLSQL_OBJECT_SETTINGS',
            COLUMN_NAME: 'PLSQL_IMPLICIT_CONVERSION_BOOL',
          },
          { TABLE_NAME: 'ALL_PROCEDURES', COLUMN_NAME: 'SQL_MACRO' },
          { TABLE_NAME: 'ALL_PROCEDURES', COLUMN_NAME: 'POLYMORPHIC' },
        ];
      else if (sql.includes("SYS_CONTEXT('USERENV'"))
        rows = [{ SESSION_USER: 'APP' }];
      else if (sql.includes('FROM all_objects o'))
        rows = [
          {
            OBJECT_TYPE: 'PROCEDURE',
            OBJECT_ID: 42,
            LAST_DDL_TIME: '20260928000000',
            STATUS: 'VALID',
            EDITIONABLE: 'Y',
            EDITION_NAME: null,
            SHARING: 'NONE',
            ORACLE_MAINTAINED: 'N',
          },
        ];
      else if (sql.includes('FROM all_plsql_object_settings'))
        rows = [
          {
            PLSQL_OPTIMIZE_LEVEL: 2,
            PLSQL_CODE_TYPE: 'INTERPRETED',
            PLSQL_DEBUG: 'FALSE',
            PLSQL_WARNINGS: 'DISABLE:ALL',
            NLS_LENGTH_SEMANTICS: 'BYTE',
            PLSQL_CCFLAGS: null,
            PLSCOPE_SETTINGS: 'IDENTIFIERS:NONE',
            PLSQL_IMPLICIT_CONVERSION_BOOL: 'FALSE',
          },
        ];
      else if (sql.includes('FROM all_source'))
        rows = [
          { LINE: 1, TEXT: 'PROCEDURE P AS\n' },
          { LINE: 2, TEXT: null },
          { LINE: 3, TEXT: 'BEGIN NULL; END;' },
        ];
      else if (sql.includes('FROM all_procedures'))
        rows = [
          {
            PROCEDURE_NAME: null,
            SUBPROGRAM_ID: 1,
            OVERLOAD: null,
            AUTHID: 'DEFINER',
            DETERMINISTIC: 'NO',
            RESULT_CACHE: 'NO',
            PIPELINED: 'NO',
            PARALLEL: 'NO',
            AGGREGATE: 'NO',
            SQL_MACRO: 'NULL',
            INTERFACE: 'NO',
            POLYMORPHIC: 'NULL',
            IMPLTYPEOWNER: null,
          },
        ];
      else if (sql.includes('FROM all_dependencies'))
        rows = [
          {
            REFERENCED_OWNER: 'SYS',
            REFERENCED_NAME: 'STANDARD',
            REFERENCED_TYPE: 'PACKAGE',
            REFERENCED_LINK_NAME: null,
            ORACLE_MAINTAINED: 'Y',
          },
        ];
      else if (sql.includes('product_component_version'))
        rows = [{ VERSION: '23.0.0.0.0' }];
      rows = mutate(sql, rows);
      let offset = 0;
      opens++;
      return {
        resultSet: {
          async getRows() {
            return rows.slice(offset, ++offset);
          },
          async close() {
            closes++;
          },
        },
      };
    },
  } as unknown as Connection;
  return { connection, statements, counts: () => ({ opens, closes }) };
}
const selection = {
  version: 3 as const,
  procedures: [{ owner: 'APP', name: 'P' }],
};

test('read-only program extraction pages complete source including blank rows and no-argument procedures', async () => {
  const fake = transport();
  const source = await extractSource(
    new OracleCatalog(fake.connection),
    selection,
  );
  assert.equal(
    source.programUnits[0].sourceLines.map((line) => line.text).join(''),
    'PROCEDURE P AS\nBEGIN NULL; END;',
  );
  assert.equal(source.programUnits[0].dependencies[0].oracleMaintained, true);
  assert.equal(source.tables.length, 0);
  assert.equal(fake.counts().opens, fake.counts().closes);
  assert.ok(
    fake.statements.every(
      (sql) => !sql.includes('NEXTVAL') && !sql.includes('DBMS_METADATA'),
    ),
  );
});

test('program extraction closes result sets and fails safely for source gaps, duplicate lines, unknown settings and hidden ownership classification', async () => {
  for (const mutate of [
    (sql: string, rows: Record<string, unknown>[]) =>
      sql.includes('FROM all_source') ? rows.slice(1) : rows,
    (sql: string, rows: Record<string, unknown>[]) =>
      sql.includes('FROM all_source') ? [rows[0], ...rows] : rows,
    (sql: string, rows: Record<string, unknown>[]) =>
      sql.includes('FROM all_plsql_object_settings')
        ? [{ ...rows[0], PLSQL_DEBUG: 'MYSTERY' }]
        : rows,
    (sql: string, rows: Record<string, unknown>[]) =>
      sql.includes('FROM all_dependencies')
        ? [{ ...rows[0], ORACLE_MAINTAINED: null }]
        : rows,
  ]) {
    const fake = transport(mutate);
    await assert.rejects(
      extractSource(new OracleCatalog(fake.connection), selection),
      /CATALOG_/,
    );
    assert.equal(fake.counts().opens, fake.counts().closes);
  }
});

test('program extraction detects concurrent DDL and rejects incorrect routine root kinds', async () => {
  let reads = 0;
  const fake = transport((sql, rows) =>
    sql.includes('FROM all_objects o') && ++reads > 1
      ? [{ ...rows[0], OBJECT_ID: 99 }]
      : rows,
  );
  await assert.rejects(
    extractSource(new OracleCatalog(fake.connection), selection),
    /concurrent program DDL/,
  );
  await assert.rejects(
    extractSource(new OracleCatalog(transport().connection), {
      version: 3,
      functions: selection.procedures,
    }),
    /FUNCTION_SELECTION_NOT_FOUND/,
  );
});
