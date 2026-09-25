import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { extractSource } from '../src/extract.js';
import { benchmarkConnection } from './helpers/benchmark-catalog.js';
import { tableConnection } from './helpers/catalog-connection.js';

for (const count of [0, 1, 31, 32, 33, 65]) {
  test(`batch boundaries preserve metadata for ${count} constraints and indexes`, async () => {
    const workload = {
      tables: 2,
      constraints: count,
      indexes: count,
      viewDepth: 3,
      latencyMs: 0,
    };
    const selection = {
      version: 2 as const,
      tables: [
        { owner: 'Owner "A', name: 'T0' },
        { owner: 'Owner B', name: 'T1' },
      ],
      views: [{ owner: 'Owner "A', name: 'V0' }],
    };
    const baseline = benchmarkConnection(workload),
      batched = benchmarkConnection(workload);
    const before = await extractSource(
      new OracleCatalog(baseline.connection, 'dba', undefined, 1),
      selection,
    );
    const after = await extractSource(
      new OracleCatalog(batched.connection, 'dba'),
      selection,
    );
    assert.deepEqual(
      { ...after, extractedAt: '' },
      { ...before, extractedAt: '' },
    );
    if (count > 1)
      assert.ok(batched.stats().queries < baseline.stats().queries);
  });
}

/** Rewrite fetched rows while retaining SQL/bind routing through the real adapter. */
function intercept(
  connection: Connection,
  mutate: (
    sql: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[],
): Connection {
  return {
    async execute(sql: string, binds: Record<string, string>) {
      const result = await connection.execute(sql, binds);
      const set = result.resultSet!;
      return {
        resultSet: {
          async getRows(count: number) {
            return mutate(
              sql,
              (await set.getRows(count)) as Record<string, unknown>[],
            );
          },
          async close() {
            await set.close();
          },
        },
      };
    },
  } as unknown as Connection;
}

for (const view of ['cons_columns', 'ind_columns', 'ind_expressions']) {
  for (const failure of ['missing', 'outside', 'duplicate', 'late-invalid']) {
    if (view === 'ind_expressions' && failure === 'missing') continue; // No expression is valid for an ordinary key.
    test(`batched ${view} rejects ${failure} members`, async () => {
      const base = benchmarkConnection({
        tables: 1,
        constraints: 3,
        indexes: 3,
        viewDepth: 0,
        latencyMs: 0,
      });
      const connection = intercept(base.connection, (sql, rows) => {
        if (!sql.includes(`FROM dba_${view}`) || !rows.length) return rows;
        if (failure === 'missing') return rows.slice(1);
        if (failure === 'outside')
          return [{ ...rows[0], MEMBER_OWNER: 'outside' }, ...rows.slice(1)];
        if (failure === 'duplicate') return [...rows, rows[0]];
        return [...rows, { ...rows[0], MEMBER_NAME: undefined }];
      });
      await assert.rejects(
        new OracleCatalog(connection, 'dba').table({ owner: 'APP', name: 'T' }),
        /CATALOG_(INCOMPLETE_METADATA|CARDINALITY)/,
      );
    });
  }
}

test('batched FK pairs bind exact multi-owner quoted names without expanding scope', async () => {
  const statements: string[] = [];
  const owners = ['Owner "A', 'Owner.B'];
  const constraintNames = ['FK "x', 'PK . x'];
  const connection = {
    async execute(sql: string, binds: Record<string, string>) {
      statements.push(sql);
      assert.ok(!sql.includes('dba_'));
      const base = tableConnection((query, rows) => {
        if (query.includes('FROM dba_constraints c'))
          return [
            {
              ...rows[0],
              OWNER: owners[0],
              CONSTRAINT_NAME: constraintNames[0],
              CONSTRAINT_TYPE: 'R',
              R_OWNER: owners[1],
              R_CONSTRAINT_NAME: constraintNames[1],
              PARENT_TABLE_NAME: 'Parent "T',
              DELETE_RULE: 'NO ACTION',
            },
          ];
        if (query.includes('FROM dba_cons_columns')) {
          assert.equal(Object.keys(binds).length, 4);
          assert.deepEqual(
            new Set(Object.values(binds)),
            new Set([...owners, ...constraintNames]),
          );
          return Object.keys(binds)
            .filter((key) => key.startsWith('name'))
            .flatMap((key) =>
              [1, 2].map((position) => ({
                MEMBER_OWNER: binds[`owner${key.slice(4)}`],
                MEMBER_NAME: binds[key],
                POSITION: position,
                COLUMN_NAME: `C${position}`,
              })),
            );
        }
        return rows;
      });
      return base.execute(sql.replaceAll('all_', 'dba_'), binds);
    },
  } as unknown as Connection;
  const foreignKeys = await new OracleCatalog(connection).foreignKeys({
    owner: owners[0],
    name: 'Child',
  });
  assert.equal(statements.length, 2);
  assert.deepEqual(foreignKeys[0].columnPairs, [
    { childColumn: 'C1', parentColumn: 'C1' },
    { childColumn: 'C2', parentColumn: 'C2' },
  ]);
  for (const sql of statements)
    for (const name of [...owners, ...constraintNames])
      assert.ok(!sql.includes(name));
});

test('batched LONG expressions and more than 100 fetched members remain complete', async () => {
  const expression = 'ABS("VALUE") /*' + 'long '.repeat(10000) + '*/';
  const connection = tableConnection((sql, rows) => {
    if (sql.includes('FROM dba_indexes'))
      return [rows[0], { ...rows[0], INDEX_NAME: 'IX_TWO' }];
    if (
      sql.includes('FROM dba_ind_columns') ||
      sql.includes('FROM dba_ind_expressions')
    )
      return ['IX_TWO', 'IX_VALUE'].flatMap((name) =>
        Array.from({ length: 101 }, (_, index) => ({
          ...rows[0],
          MEMBER_OWNER: 'APP',
          MEMBER_NAME: name,
          COLUMN_POSITION: index + 1,
          ...(sql.includes('FROM dba_ind_expressions')
            ? { COLUMN_EXPRESSION: expression }
            : {}),
        })),
      );
    return rows;
  });
  const table = await new OracleCatalog(connection, 'dba').table({
    owner: 'APP',
    name: 'T',
  });
  for (const index of table.indexes) {
    assert.equal(index.keys.length, 101);
    assert.ok(index.keys.every((key) => key.expression === expression));
  }
});

test('batch size is bounded and validated before querying', () => {
  for (const size of [0, -1, 129, NaN, 1.5])
    assert.throws(
      () => new OracleCatalog({} as Connection, 'all', undefined, size),
      /batch size/,
    );
});

test('a failed constraint member batch never publishes partial cache entries', async () => {
  const base = benchmarkConnection({
    tables: 1,
    constraints: 3,
    indexes: 0,
    viewDepth: 0,
    latencyMs: 0,
  });
  let fail = true,
    memberQueries = 0;
  const connection = intercept(base.connection, (sql, rows) => {
    if (sql.includes('FROM dba_cons_columns') && rows.length) {
      memberQueries++;
      if (fail) return rows.slice(0, -1);
    }
    return rows;
  });
  const catalog = new OracleCatalog(connection, 'dba');
  await assert.rejects(
    catalog.table({ owner: 'APP', name: 'T' }),
    /CATALOG_INCOMPLETE_METADATA/,
  );
  fail = false;
  assert.equal(
    (await catalog.table({ owner: 'APP', name: 'T' })).constraints.length,
    3,
  );
  assert.equal(memberQueries, 2);
});
