import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle, { type Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { extractSource } from '../src/extract.js';
import { transformSource } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { policySchema, type SourceDocument } from '../src/model.js';
import { ExtractionProgress, type ProgressEvent } from '../src/progress.js';
import { benchmarkConnection } from './helpers/benchmark-catalog.js';

const reference = (name: string, owner = 'Owner "A') => ({ owner, name });
const withoutTime = (source: SourceDocument) => ({
  ...source,
  extractedAt: '',
});
const workload = {
  tables: 74,
  constraints: 1,
  indexes: 1,
  viewDepth: 0,
  latencyMs: 0,
};

/** Enforce sequential execute/fetch/close and permit late-page fault injection. */
function inspect(
  connection: Connection,
  mutate: (
    sql: string,
    rows: Record<string, unknown>[],
    binds: Record<string, string>,
  ) => Record<string, unknown>[] = (_, rows) => rows,
) {
  let active = false;
  let executes = 0;
  let closes = 0;
  const statements: { sql: string; binds: Record<string, string> }[] = [];
  return {
    statements,
    counts: () => ({ executes, closes }),
    connection: {
      async execute(sql: string, binds: Record<string, string>) {
        assert.equal(
          active,
          false,
          'A connection must finish fetching and closing before another query',
        );
        active = true;
        executes++;
        statements.push({ sql, binds });
        const result = await connection.execute(sql, binds);
        return {
          resultSet: {
            async getRows(count: number) {
              return mutate(
                sql,
                (await result.resultSet!.getRows(count)) as Record<
                  string,
                  unknown
                >[],
                binds,
              );
            },
            async close() {
              await result.resultSet!.close();
              closes++;
              active = false;
            },
          },
        };
      },
    } as unknown as Connection,
  };
}

for (const count of [1, 31, 32, 33, 65, 74]) {
  for (const kind of ['tables', 'views'] as const) {
    test(`${count} ${kind} preserve metadata across object batch boundaries`, async () => {
      const objects = Array.from({ length: count }, (_, i) =>
        reference(
          `${kind === 'tables' ? 'T' : 'V'}${Math.floor(i / 2)}`,
          i % 2 ? 'Owner.B' : 'Owner "A',
        ),
      );
      const selection = {
        version: 2 as const,
        tables: kind === 'tables' ? objects : [],
        views: kind === 'views' ? objects : [],
      };
      const sources: SourceDocument[] = [];
      const executions: number[] = [];
      for (const size of [1, 32]) {
        const transport = inspect(benchmarkConnection(workload).connection);
        sources.push(
          await extractSource(
            new OracleCatalog(transport.connection, 'dba', undefined, size),
            selection,
          ),
        );
        executions.push(transport.counts().executes);
        assert.equal(transport.counts().executes, transport.counts().closes);
        for (const { sql, binds } of transport.statements) {
          assert.ok(!sql.includes('Owner "A') && !sql.includes('Owner.B'));
          if (sql.startsWith('WITH selected_objects')) {
            assert.ok(
              Object.keys(binds).filter((key) => /^owner\d+$/.test(key))
                .length <= size,
            );
          }
        }
      }
      assert.deepEqual(withoutTime(sources[1]), withoutTime(sources[0]));
      assert.equal(sources[1][kind].length, count);
      if (count > 1) assert.ok(executions[1] < executions[0]);
      if (count === 1) assert.equal(executions[1], executions[0]);
    });
  }
}

test('74-table and wide-view executions beat the recorded pre-change baseline by 80%', async () => {
  const tableTransport = benchmarkConnection(workload);
  await extractSource(new OracleCatalog(tableTransport.connection, 'dba'), {
    version: 2,
    tables: Array.from({ length: 74 }, (_, i) => reference(`T${i}`)),
    views: [],
  });
  assert.equal(tableTransport.stats().queries, 40);
  assert.ok(tableTransport.stats().queries <= 889 * 0.2);
  const events: ProgressEvent[] = [];
  const progress = new ExtractionProgress((event) => events.push(event));
  const viewTransport = benchmarkConnection(workload);
  await extractSource(
    new OracleCatalog(viewTransport.connection, 'dba', progress),
    {
      version: 2,
      tables: [],
      views: Array.from({ length: 74 }, (_, i) => reference(`V${i}`)),
    },
    progress,
  );
  const viewQueries = events.filter(
    (event) =>
      event.stage === 'query' &&
      event.event === 'complete' &&
      event.queryCategory?.startsWith('view'),
  );
  assert.equal(viewQueries.length, 12);
  assert.ok(viewQueries.length <= 296 * 0.2);
  assert.ok(viewQueries.every((event) => event.object === undefined));
  assert.equal(
    events.filter(
      (event) => event.stage === 'object' && event.event === 'complete',
    ).length,
    75,
  );
});

for (const category of [
  'table',
  'table-comments',
  'columns',
  'column-comments',
  'constraints',
  'indexes',
  'view',
  'view-columns',
]) {
  for (const failure of ['outside', 'duplicate', 'late-invalid', 'missing']) {
    // These categories allow an empty set; indexes require ordered keys separately.
    if (failure === 'missing' && ['constraints', 'indexes'].includes(category))
      continue;
    test(`cross-object ${category} rejects ${failure} rows and a retry reloads the failed batch`, async () => {
      let queryCategory = '';
      let failing = true;
      const events: ProgressEvent[] = [];
      const progress = new ExtractionProgress((event) => {
        events.push(event);
        if (event.stage === 'query' && event.event === 'start')
          queryCategory = event.queryCategory!;
      });
      const base = benchmarkConnection(workload);
      const transport = inspect(base.connection, (sql, rows) => {
        if (
          !failing ||
          !sql.startsWith('WITH selected_objects') ||
          queryCategory !== category ||
          !rows.length
        )
          return rows;
        if (failure === 'outside')
          return [{ ...rows[0], MEMBER_OWNER: 'outside' }, ...rows.slice(1)];
        if (failure === 'duplicate') return [...rows, rows[0]];
        if (failure === 'missing') return rows.slice(1);
        return [...rows, { ...rows[0], MEMBER_NAME: undefined }];
      });
      const catalog = new OracleCatalog(transport.connection, 'dba', progress);
      const refs = [reference('T0'), reference('T1')];
      const prepare = () =>
        category.startsWith('view')
          ? catalog.prefetchViews(refs)
          : catalog.prefetchTables(refs);
      await assert.rejects(
        prepare(),
        /CATALOG_(INCOMPLETE_METADATA|CARDINALITY)/,
      );
      assert.equal(transport.counts().executes, transport.counts().closes);
      const beforeRetry = base.stats().queries;
      const retryEventStart = events.length;
      failing = false;
      await prepare();
      assert.ok(base.stats().queries > beforeRetry);
      for (const ref of refs) {
        const value = category.startsWith('view')
          ? await catalog.view(ref)
          : await catalog.table(ref);
        assert.equal(value.reference.name, ref.name);
      }
      // Both objects were re-read, rather than returning an early partial success.
      const reloaded = events
        .slice(retryEventStart)
        .filter(
          (event) =>
            event.stage === 'query' &&
            event.event === 'complete' &&
            event.queryCategory ===
              (category.startsWith('view') ? 'view' : 'table'),
        );
      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0].rows, 2);
    });
  }
}

test('cross-table batches preserve complete LONGs and close on an invalid late page', async () => {
  const long = ' /*' + 'unicode Ω '.repeat(6000) + '*/';
  let failLate = false;
  let columnPage = 0;
  const transport = inspect(
    benchmarkConnection({ ...workload, constraints: 74 }).connection,
    (sql, rows) => {
      if (
        sql.includes('FROM dba_tab_cols') &&
        !sql.includes('FROM dba_col_comments')
      ) {
        columnPage++;
        if (failLate && columnPage === 2)
          return [{ MEMBER_OWNER: 'Owner "A', MEMBER_NAME: 'T0' }];
        return rows.map((row) => ({ ...row, DATA_DEFAULT: '1' + long }));
      }
      if (sql.includes('FROM dba_constraints c'))
        return rows.map((row) => ({
          ...row,
          CONSTRAINT_TYPE: 'C',
          SEARCH_CONDITION: '"VALUE">=0' + long,
        }));
      if (sql.includes('FROM dba_ind_expressions'))
        return rows.map((row) => ({
          ...row,
          COLUMN_EXPRESSION: 'ABS("VALUE")' + long,
        }));
      if (sql.includes('FROM dba_views'))
        return rows.map((row) => ({
          ...row,
          TEXT: 'SELECT VALUE FROM T0' + long,
        }));
      return rows;
    },
  );
  const refs = [reference('T0'), reference('T1')];
  const catalog = new OracleCatalog(transport.connection, 'dba');
  await catalog.prefetchTables(refs);
  for (const ref of refs) {
    const table = await catalog.table(ref);
    assert.equal(table.columns[0].defaultExpression, '1' + long);
    assert.equal(table.constraints.length, 74);
    assert.ok(
      table.constraints.every(
        (constraint) =>
          constraint.kind === 'check' &&
          constraint.expression === '"VALUE">=0' + long,
      ),
    );
    assert.equal(table.indexes[0].keys[0].expression, 'ABS("VALUE")' + long);
  }
  await catalog.prefetchViews(refs);
  for (const ref of refs)
    assert.equal(
      (await catalog.view(ref)).query,
      'SELECT VALUE FROM T0' + long,
    );
  columnPage = 0;
  failLate = true;
  await assert.rejects(
    catalog.prefetchTables(refs),
    /CATALOG_INCOMPLETE_METADATA/,
  );
  assert.equal(transport.counts().executes, transport.counts().closes);
});

test('single and batched extraction produce identical transformed documents and SQL', async () => {
  const outputs = [];
  for (const size of [1, 32]) {
    const transport = inspect(
      benchmarkConnection(workload).connection,
      (sql, rows) => {
        // Give the unique constraint a real ordinary unique backing index.
        if (sql.includes('FROM dba_constraints c'))
          return rows.map((row) => ({
            ...row,
            INDEX_OWNER: row.OWNER,
            INDEX_NAME: String(row.CONSTRAINT_NAME).replace('_C', '_I'),
          }));
        if (
          sql.includes('FROM dba_indexes') &&
          !sql.includes('FROM dba_dependencies')
        )
          return rows.map((row) => ({
            ...row,
            INDEX_TYPE: 'NORMAL',
            UNIQUENESS: 'UNIQUE',
          }));
        if (sql.includes('FROM dba_ind_expressions')) return [];
        if (sql.includes('FROM dba_ind_columns'))
          return rows.map((row) => ({
            ...row,
            COLUMN_NAME: 'VALUE',
            DESCEND: 'ASC',
          }));
        return rows;
      },
    );
    const source = await extractSource(
      new OracleCatalog(transport.connection, 'dba', undefined, size),
      {
        version: 2,
        tables: [reference('T0'), reference('T1')],
        views: [reference('V0'), reference('V1')],
      },
    );
    const target = transformSource(
      { ...source, extractedAt: '2026-09-28T00:00:00.000Z' },
      policySchema.parse({}),
    );
    outputs.push({ target, sql: generateSql(target) });
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

test('batched cross-owner index dependencies retain each index and its own table context', async () => {
  const base = benchmarkConnection(workload);
  let emittedDependencies = false;
  const transport = inspect(base.connection, (sql, rows, binds) => {
    if (
      sql.includes('FROM dba_indexes') &&
      !sql.includes('FROM dba_dependencies')
    ) {
      return rows.map((row) => ({ ...row, OWNER: 'Index "Owner' }));
    }
    if (sql.includes("d.type='INDEX'") && !sql.includes("d.type='TABLE'")) {
      if (emittedDependencies) return [];
      emittedDependencies = true;
      return Object.keys(binds)
        .filter((key) => /^indexName\d+$/.test(key))
        .map((key) => {
          const suffix = key.slice('indexName'.length);
          assert.equal(binds[`owner${suffix}`], 'Index "Owner');
          assert.equal(
            binds[`indexName${suffix}`],
            `${binds[`tableName${suffix}`]}_I0`,
          );
          assert.ok(
            ['Table A', 'Table B'].includes(binds[`tableOwner${suffix}`]),
          );
          return {
            MEMBER_OWNER: binds[`owner${suffix}`],
            MEMBER_NAME: binds[key],
            REFERENCED_OWNER: binds[`tableOwner${suffix}`],
            REFERENCED_NAME: `FN_${binds[`tableName${suffix}`]}`,
            REFERENCED_TYPE: 'FUNCTION',
            REFERENCED_LINK_NAME: null,
          };
        });
    }
    return rows;
  });
  const catalog = new OracleCatalog(transport.connection, 'dba');
  const refs = [reference('T0', 'Table A'), reference('T1', 'Table B')];
  await catalog.prefetchTables(refs);
  for (const ref of refs) {
    const table = await catalog.table(ref);
    assert.deepEqual(
      table.indexes[0].reference,
      reference(`${ref.name}_I0`, 'Index "Owner'),
    );
    assert.deepEqual(table.indexes[0].dependencies, [
      {
        reference: reference(`FN_${ref.name}`, ref.owner),
        type: 'FUNCTION',
        databaseLink: null,
      },
    ]);
  }
});

test('optional empty metadata is cached and table dependency filters remain distinct', async () => {
  const transport = inspect(
    benchmarkConnection({ ...workload, indexes: 0, constraints: 0 }).connection,
  );
  const catalog = new OracleCatalog(transport.connection, 'dba');
  const refs = [reference('T0'), reference('T1')];
  await catalog.prefetchTables(refs);
  const before = transport.counts().executes;
  for (const ref of refs) {
    const table = await catalog.table(ref);
    assert.deepEqual(table.indexes, []);
    assert.deepEqual(table.constraints, []);
    assert.deepEqual(await catalog.prerequisites(ref), []);
  }
  assert.equal(transport.counts().executes, before);
  const query = transport.statements.find(({ sql }) =>
    sql.includes("d.type='TABLE'"),
  )!;
  assert.ok(query.sql.includes("d.referenced_type<>'TABLE'"));
  assert.ok(
    query.sql.includes('identity_column.sequence_name=d.referenced_name'),
  );
});

test('a failed later object batch keeps earlier complete batches and reloads every failed object', async () => {
  const refs = Array.from({ length: 33 }, (_, i) =>
    reference(`T${String(i).padStart(2, '0')}`),
  );
  let fail = true;
  const transport = inspect(
    benchmarkConnection(workload).connection,
    (sql, rows, binds) => {
      if (
        fail &&
        sql.includes('FROM dba_col_comments') &&
        binds.tableName === 'T32'
      )
        return [];
      return rows;
    },
  );
  const catalog = new OracleCatalog(transport.connection, 'dba');
  await assert.rejects(
    catalog.prefetchTables(refs),
    /CATALOG_INCOMPLETE_METADATA/,
  );
  const queries = transport.counts().executes;
  // Earlier successful objects remain available with no additional queries.
  assert.equal((await catalog.table(refs[0])).reference.name, 'T00');
  assert.equal(transport.counts().executes, queries);
  fail = false;
  await catalog.prefetchTables(refs.slice(1));
  assert.equal((await catalog.table(refs[32])).reference.name, 'T32');
  assert.equal(
    transport.statements.filter(
      ({ sql, binds }) =>
        sql.includes('FROM dba_constraints c') && binds.tableName === 'T32',
    ).length,
    2,
  );
});

test('deep view chains remain incremental and visit each view once', async () => {
  const events: ProgressEvent[] = [];
  const progress = new ExtractionProgress((event) => events.push(event));
  const transport = benchmarkConnection({ ...workload, viewDepth: 65 });
  const source = await extractSource(
    new OracleCatalog(transport.connection, 'dba', progress),
    {
      version: 2,
      tables: [],
      views: [reference('V0')],
    },
  );
  assert.equal(source.views.length, 65);
  assert.deepEqual(
    source.views.map((view) => view.reference.name),
    Array.from({ length: 65 }, (_, i) => `V${i}`),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.stage === 'query' &&
        event.event === 'complete' &&
        event.queryCategory?.startsWith('view'),
    ).length,
    260,
  );
  assert.equal(source.tables.length, 1);
});

test('one index identity cannot be assigned to two selected tables', async () => {
  const transport = inspect(
    benchmarkConnection(workload).connection,
    (sql, rows) => {
      if (
        sql.includes('FROM dba_indexes') &&
        !sql.includes('FROM dba_dependencies')
      ) {
        return rows.map((row) => ({
          ...row,
          OWNER: 'INDEX_OWNER',
          INDEX_NAME: 'SHARED',
        }));
      }
      return rows;
    },
  );
  await assert.rejects(
    new OracleCatalog(transport.connection, 'dba').prefetchTables([
      reference('T0'),
      reference('T1'),
    ]),
    /CATALOG_CARDINALITY/,
  );
});

for (const scope of ['all', 'dba'] as const) {
  test(`${scope.toUpperCase()} extraction only reads the supplied connection and never executes captured view SQL`, async (context) => {
    const connect = context.mock.method(oracle, 'getConnection', async () => {
      throw new Error('Extraction must not open another database connection');
    });
    for (const size of [1, 32]) {
      const base = benchmarkConnection(workload).connection;
      const capturedText = 'DELETE FROM DESTINATION.IMPORTANT_TABLE';
      const queries: string[] = [];
      const sourceConnection = {
        async execute(sql: string, binds: Record<string, string>) {
          queries.push(sql);
          assert.match(sql, /^(SELECT\b|WITH selected_objects AS \()/);
          assert.doesNotMatch(
            sql,
            /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|BEGIN|DECLARE|CALL|EXECUTE|NEXTVAL)\b/i,
          );
          assert.doesNotMatch(sql, /FOR\s+UPDATE/i);
          assert.ok(!sql.includes(capturedText));
          assert.ok(!sql.includes(scope === 'all' ? 'dba_' : 'all_'));
          // The fixture uses DBA names internally; check the real statement before adapting it.
          const result = await base.execute(
            sql.replaceAll('all_', 'dba_'),
            binds,
          );
          return {
            resultSet: {
              async getRows(count: number) {
                const rows = (await result.resultSet!.getRows(count)) as Record<
                  string,
                  unknown
                >[];
                return sql.includes(`FROM ${scope}_views`)
                  ? rows.map((row) => ({ ...row, TEXT: capturedText }))
                  : rows;
              },
              async close() {
                await result.resultSet!.close();
              },
            },
          };
        },
        async executeMany() {
          assert.fail('Extraction must not execute bulk writes');
        },
        async commit() {
          assert.fail('Extraction must not commit');
        },
      } as unknown as Connection;
      const source = await extractSource(
        new OracleCatalog(sourceConnection, scope, undefined, size),
        {
          version: 2,
          tables: [reference('T0'), reference('T1')],
          views: [reference('V0'), reference('V1')],
        },
      );
      assert.equal(source.tables.length, 2);
      assert.equal(source.views.length, 2);
      assert.ok(source.views.every((view) => view.query === capturedText));
      assert.ok(queries.length > 0);
      if (size === 32)
        assert.ok(
          queries.some((sql) => sql.startsWith('WITH selected_objects')),
        );
    }
    assert.equal(connect.mock.callCount(), 0);
  });
}
