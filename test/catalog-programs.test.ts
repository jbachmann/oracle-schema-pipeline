import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';

function mockCatalog(
  change: (
    category: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[] = (_, rows) => rows,
) {
  const calls: { sql: string; binds: unknown }[] = [];
  let closed = 0;
  const connection = {
    execute: async (sql: string, binds: unknown) => {
      calls.push({ sql, binds });
      let category: string;
      let rows: Record<string, unknown>[];
      if (sql.includes('FROM dba_objects')) {
        category = 'object';
        rows = [
          {
            OBJECT_TYPE: 'PROCEDURE',
            STATUS: 'VALID',
            EDITIONABLE: 'Y',
            ORACLE_MAINTAINED: 'N',
            EDITIONS_ENABLED: 'N',
          },
        ];
      } else if (sql.includes('FROM dba_procedures')) {
        category = 'member';
        rows = [
          {
            PROCEDURE_NAME: null,
            OVERLOAD: null,
            SUBPROGRAM_ID: 1,
            AUTHID: 'DEFINER',
            RETURN_COUNT: 0,
          },
        ];
      } else if (sql.includes('FROM dba_source')) {
        category = 'source';
        rows = [
          { LINE: 1, TEXT: 'PROCEDURE "P.dot" AS\r\n' },
          { LINE: 2, TEXT: null },
          { LINE: 3, TEXT: 'BEGIN NULL; END;\n' },
        ];
      } else if (sql.includes('FROM dba_plsql_object_settings')) {
        category = 'settings';
        rows = [
          {
            PLSQL_OPTIMIZE_LEVEL: 2,
            PLSQL_CODE_TYPE: 'INTERPRETED',
            PLSQL_DEBUG: 'FALSE',
            PLSQL_WARNINGS: 'DISABLE:ALL',
            NLS_LENGTH_SEMANTICS: 'BYTE',
            PLSQL_CCFLAGS: null,
            PLSCOPE_SETTINGS: 'IDENTIFIERS:NONE',
          },
        ];
      } else {
        category = 'dependency';
        rows = [];
      }
      const result = change(category, rows);
      let offset = 0;
      return {
        resultSet: {
          getRows: async () => result.slice(offset, ++offset),
          close: async () => {
            closed++;
          },
        },
      };
    },
  } as unknown as Connection;
  return {
    catalog: new OracleCatalog(connection, 'dba'),
    calls,
    closed: () => closed,
  };
}
const reference = { owner: 'Owner Space', name: 'P.dot' };
test('program reads retain exact identities, complete paged source and explicit DBA scope', async () => {
  const fixture = mockCatalog();
  const program = await fixture.catalog.program(reference);
  assert.equal(
    program.units[0].sourceLines.map((line) => line.text).join(''),
    'PROCEDURE "P.dot" AS\r\nBEGIN NULL; END;\n',
  );
  assert.equal(fixture.calls.length, fixture.closed());
  assert.ok(
    fixture.calls.every(
      (call) =>
        !call.sql.includes('all_') &&
        !call.sql.includes(reference.owner) &&
        !call.sql.includes(reference.name),
    ),
  );
  assert.deepEqual(fixture.calls[0].binds, {
    owner: reference.owner,
    programName: reference.name,
  });
});
test('program decoding rejects hidden, gapped, duplicate and unknown metadata and closes cursors', async () => {
  for (const change of [
    (category: string, rows: Record<string, unknown>[]) =>
      category === 'source' ? [] : rows,
    (category: string, rows: Record<string, unknown>[]) =>
      category === 'source' ? rows.filter((row) => row.LINE !== 2) : rows,
    (category: string, rows: Record<string, unknown>[]) =>
      category === 'object' ? [...rows, ...rows] : rows,
    (category: string, rows: Record<string, unknown>[]) =>
      category === 'settings' ? [{ ...rows[0], PLSQL_DEBUG: 'UNKNOWN' }] : rows,
    (category: string, rows: Record<string, unknown>[]) =>
      category === 'dependency'
        ? [
            {
              REFERENCED_OWNER: 'APP',
              REFERENCED_NAME: 'T',
              REFERENCED_TYPE: 'TABLE',
              REFERENCED_LINK_NAME: null,
              ORACLE_MAINTAINED: null,
            },
          ]
        : rows,
  ]) {
    const fixture = mockCatalog(change);
    await assert.rejects(fixture.catalog.program(reference), /CATALOG_/u);
    assert.equal(fixture.calls.length, fixture.closed());
  }
});
test('prefetch stages complete definitions and consumes them once', async () => {
  const fixture = mockCatalog();
  await fixture.catalog.prefetchPrograms([reference, reference]);
  const count = fixture.calls.length;
  await fixture.catalog.program(reference);
  assert.equal(fixture.calls.length, count);
  await fixture.catalog.program(reference);
  assert.equal(fixture.calls.length, count * 2);
});

test('ALL scope rejects missing owner edition metadata without querying DBA or executing source', async () => {
  let queries = 0;
  const connection = {
    execute: async () => {
      queries++;
      throw new Error('Unexpected query');
    },
  } as unknown as Connection;
  await assert.rejects(
    new OracleCatalog(connection, 'all').program(reference),
    /CATALOG_INCOMPLETE_METADATA.*sourceOwnerEditionsEnabled/u,
  );
  assert.equal(queries, 0);
});

test('failed program prefetch does not publish the earlier members of its incomplete batch', async () => {
  let objects = 0;
  const fixture = mockCatalog((category, rows) =>
    category === 'object' && ++objects === 2 ? [] : rows,
  );
  const first = { owner: 'A', name: reference.name };
  const second = { owner: 'B', name: reference.name };
  await assert.rejects(
    fixture.catalog.prefetchPrograms([second, first]),
    /CATALOG_CARDINALITY/u,
  );
  const before = fixture.calls.length;
  await fixture.catalog.program(first);
  assert.ok(
    fixture.calls.length > before,
    'Failed batch member must be re-read',
  );
  assert.equal(fixture.closed(), fixture.calls.length);
});
