import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';

function tableConnection(
  mutate: (sql: string, rows: Record<string, unknown>[]) => unknown[] = (
    _sql,
    rows,
  ) => rows,
  closed: () => void = () => {},
  statements: string[] = [],
  longPredicate = '"VALUE" >= 0',
): Connection {
  return {
    async execute(sql: string) {
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes('FROM dba_tables'))
        rows = [
          {
            TABLESPACE_NAME: 'PROD',
            COMPRESSION: 'DISABLED',
            IOT_TYPE: null,
            CLUSTER_NAME: null,
            NESTED: 'NO',
            SECONDARY: 'N',
            TEMPORARY: 'N',
            PARTITIONED: 'NO',
            ORACLE_MAINTAINED: 'N',
            SPECIAL_COUNT: 0,
          },
        ];
      else if (sql.includes('FROM dba_tab_comments'))
        rows = [{ COMMENTS: "Table's café" }];
      else if (sql.includes('FROM dba_col_comments'))
        rows = [{ COLUMN_NAME: 'VALUE', COMMENTS: 'Value Ω' }];
      else if (sql.includes('FROM dba_tab_cols'))
        rows = [
          {
            COLUMN_NAME: 'VALUE',
            COLUMN_ID: 1,
            INTERNAL_COLUMN_ID: 1,
            DATA_TYPE: 'NUMBER',
            DATA_TYPE_OWNER: null,
            DATA_LENGTH: 22,
            CHAR_LENGTH: 0,
            CHAR_USED: null,
            DATA_PRECISION: null,
            DATA_SCALE: null,
            NULLABLE: 'Y',
            DATA_DEFAULT: '1',
            IDENTITY_COLUMN: 'NO',
            DEFAULT_ON_NULL: 'NO',
            VIRTUAL_COLUMN: 'NO',
            HIDDEN_COLUMN: 'NO',
            COLLATION: null,
          },
        ];
      else if (sql.includes('FROM dba_constraints c'))
        rows = [
          {
            OWNER: 'APP',
            CONSTRAINT_NAME: 'CK_VALUE',
            CONSTRAINT_TYPE: 'C',
            GENERATED: 'USER NAME',
            STATUS: 'ENABLED',
            VALIDATED: 'VALIDATED',
            DEFERRABLE: 'NOT DEFERRABLE',
            DEFERRED: 'IMMEDIATE',
            RELY: null,
            SEARCH_CONDITION: longPredicate,
            INDEX_OWNER: null,
            INDEX_NAME: null,
            R_OWNER: null,
            R_CONSTRAINT_NAME: null,
            DELETE_RULE: null,
            PARENT_TABLE_NAME: null,
          },
        ];
      else if (sql.includes('FROM dba_indexes'))
        rows = [
          {
            OWNER: 'APP',
            INDEX_NAME: 'IX_VALUE',
            INDEX_TYPE: 'FUNCTION-BASED NORMAL',
            UNIQUENESS: 'NONUNIQUE',
            VISIBILITY: 'VISIBLE',
            STATUS: 'VALID',
            PARTITIONED: 'NO',
            COMPRESSION: 'DISABLED',
          },
        ];
      else if (sql.includes('FROM dba_ind_expressions'))
        rows = [{ COLUMN_POSITION: 1, COLUMN_EXPRESSION: 'ABS("VALUE")' }];
      else if (sql.includes('FROM dba_ind_columns'))
        rows = [
          { COLUMN_NAME: 'SYS_NC00002$', COLUMN_POSITION: 1, DESCEND: 'ASC' },
        ];
      rows = mutate(sql, rows as Record<string, unknown>[]);
      let fetched = false;
      return {
        resultSet: {
          async getRows() {
            if (fetched) return [];
            fetched = true;
            return rows;
          },
          async close() {
            closed();
          },
        },
      };
    },
  } as unknown as Connection;
}

test('Oracle adapter reads full LONG expressions, ordered keys and actual index expressions', async () => {
  const longPredicate =
    '"VALUE" >= 0' + ' /* preserved metadata */'.repeat(2000);
  const statements: string[] = [];
  const connection = tableConnection(
    undefined,
    undefined,
    statements,
    longPredicate,
  );
  const table = await new OracleCatalog(connection, 'dba').table({
    owner: 'APP',
    name: 'T',
  });
  assert.equal(table.comment, "Table's café");
  assert.equal(table.columns[0].comment, 'Value Ω');
  assert.equal(table.constraints[0].kind, 'check');
  if (table.constraints[0].kind === 'check')
    assert.equal(table.constraints[0].expression, longPredicate);
  assert.deepEqual(table.indexes[0].keys[0], {
    column: null,
    expression: 'ABS("VALUE")',
    direction: 'ASC',
  });
  assert.ok(statements.some((sql) => sql.includes('c.search_condition')));
  assert.ok(
    statements.every(
      (sql) => !sql.includes('SEARCH_CONDITION_VC') && !sql.includes('GET_DDL'),
    ),
  );
});

test('catalog scope selects one complete view family', async () => {
  for (const scope of ['all', 'dba'] as const) {
    const statements: string[] = [];
    const connection = {
      async execute(sql: string) {
        statements.push(sql);
        let fetched = false;
        return {
          resultSet: {
            async getRows() {
              if (fetched) return [];
              fetched = true;
              return [];
            },
            async close() {},
          },
        };
      },
    } as unknown as Connection;
    await assert.rejects(
      new OracleCatalog(connection, scope).table({
        owner: 'APP',
        name: 'MISSING',
      }),
      /CATALOG_CARDINALITY.*table/,
    );
    const other = scope === 'all' ? 'dba_' : 'all_';
    assert.ok(statements.length > 0);
    assert.ok(statements.every((sql) => !sql.toLowerCase().includes(other)));
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));
  }
});

const reference = { owner: 'APP', name: 'T' };
for (const [label, query, field] of [
  ['table flag', 'FROM dba_tables', 'TEMPORARY'],
  ['column flag', 'FROM dba_tab_cols', 'NULLABLE'],
  ['length semantics', 'FROM dba_tab_cols', 'CHAR_USED'],
  ['constraint state', 'FROM dba_constraints c', 'STATUS'],
  ['constraint kind', 'FROM dba_constraints c', 'CONSTRAINT_TYPE'],
  ['index uniqueness', 'FROM dba_indexes', 'UNIQUENESS'],
  ['index direction', 'FROM dba_ind_columns', 'DESCEND'],
]) {
  for (const value of ['UNEXPECTED', null, undefined]) {
    // CHAR_USED legitimately permits null for non-character types.
    if (field === 'CHAR_USED' && value === null) continue;
    test(`catalog rejects ${label} ${String(value)} and closes its result set`, async () => {
      let opened = 0,
        closed = 0;
      const connection = tableConnection(
        (sql, rows) => {
          opened++;
          if (sql.includes(query)) rows[0][field] = value;
          return rows;
        },
        () => closed++,
      );
      await assert.rejects(
        new OracleCatalog(connection, 'dba').table(reference),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('CATALOG_') &&
          error.message.includes(
            field === 'DESCEND' ? 'APP.IX_VALUE' : 'APP.T',
          ) &&
          error.message.includes(field),
      );
      assert.equal(closed, opened);
    });
  }
}

for (const [label, query] of [
  ['table', 'FROM dba_tables'],
  ['column', 'FROM dba_tab_cols'],
  ['comment', 'FROM dba_col_comments'],
  ['constraint', 'FROM dba_constraints c'],
  ['index', 'FROM dba_indexes'],
  ['expression', 'FROM dba_ind_expressions'],
]) {
  test(`catalog rejects duplicate ${label} identities`, async () => {
    const connection = tableConnection((sql, rows) =>
      sql.includes(query) ? [...rows, ...rows] : rows,
    );
    await assert.rejects(
      new OracleCatalog(connection, 'dba').table(reference),
      /CATALOG_CARDINALITY/,
    );
  });
}

test('catalog rejects duplicate identity columns before Map assembly', async () => {
  const connection = tableConnection((sql, rows) =>
    sql.includes('FROM dba_tab_identity_cols')
      ? Array(2).fill({
          COLUMN_NAME: 'VALUE',
          GENERATION_TYPE: 'ALWAYS',
          IDENTITY_OPTIONS: 'START WITH: 1',
        })
      : rows,
  );
  await assert.rejects(
    new OracleCatalog(connection, 'dba').table(reference),
    /CATALOG_CARDINALITY.*COLUMN_NAME/,
  );
});

for (const query of [
  'FROM dba_col_comments',
  'FROM dba_tab_comments',
  'FROM dba_ind_columns',
]) {
  test(`catalog rejects missing metadata in ${query}`, async () => {
    const connection = tableConnection((sql, rows) =>
      sql.includes(query) ? [] : rows,
    );
    await assert.rejects(
      new OracleCatalog(connection, 'dba').table(reference),
      /CATALOG_(INCOMPLETE_METADATA|CARDINALITY)/,
    );
  });
}

test('catalog rejects index position gaps and orphan expressions', async () => {
  for (const query of ['FROM dba_ind_columns', 'FROM dba_ind_expressions']) {
    const connection = tableConnection((sql, rows) => {
      if (sql.includes(query)) rows[0].COLUMN_POSITION = 2;
      return rows;
    });
    await assert.rejects(
      new OracleCatalog(connection, 'dba').table(reference),
      /CATALOG_INCOMPLETE_METADATA/,
    );
  }
});

test('catalog rejects incomplete ordered constraint members', async () => {
  for (const members of [
    [],
    [{ COLUMN_NAME: 'VALUE', POSITION: 2 }],
    [
      { COLUMN_NAME: 'VALUE', POSITION: 1 },
      { COLUMN_NAME: 'VALUE', POSITION: 2 },
    ],
  ]) {
    const connection = tableConnection((sql, rows) => {
      if (sql.includes('FROM dba_constraints c')) rows[0].CONSTRAINT_TYPE = 'P';
      if (sql.includes('FROM dba_cons_columns')) return members;
      return rows;
    });
    await assert.rejects(
      new OracleCatalog(connection, 'dba').table(reference),
      /CATALOG_(INCOMPLETE_METADATA|CARDINALITY)/,
    );
  }
});

function viewConnection(
  readOnly = 'N',
  restrictions: Record<string, unknown>[] = [],
  mutate: (sql: string, rows: Record<string, unknown>[]) => unknown[] = (
    _sql,
    rows,
  ) => rows,
): Connection {
  return {
    async execute(sql: string) {
      let rows: Record<string, unknown>[] = sql.includes('FROM all_views')
        ? [
            {
              TEXT: `SELECT 1 FROM DUAL${readOnly === 'Y' ? ' WITH READ ONLY' : restrictions.length ? ' WITH CHECK OPTION' : ''}`,
              READ_ONLY: readOnly,
              BEQUEATH: 'DEFINER',
              EDITIONING_VIEW: 'N',
              CONTAINER_DATA: 'N',
              DEFAULT_COLLATION: 'USING_NLS_COMP',
              TYPE_TEXT: null,
              SUPERVIEW_NAME: null,
              STATUS: 'VALID',
              ORACLE_MAINTAINED: 'N',
            },
          ]
        : sql.includes('FROM all_tab_columns')
          ? [{ COLUMN_NAME: 'VALUE', POSITION: 1 }]
          : restrictions;
      const result = mutate(sql, rows);
      let fetched = false;
      return {
        resultSet: {
          async getRows() {
            if (fetched) return [];
            fetched = true;
            return result;
          },
          async close() {},
        },
      };
    },
  } as unknown as Connection;
}

for (const type of ['NONE', 'O', 'V']) {
  test(`catalog preserves ${type} view restriction text and facts`, async () => {
    const restrictions =
      type === 'NONE'
        ? []
        : [
            {
              CONSTRAINT_NAME: 'RESTRICTION',
              CONSTRAINT_TYPE: type,
              STATUS: 'ENABLED',
            },
          ];
    const view = await new OracleCatalog(
      viewConnection(type === 'O' ? 'Y' : 'N', restrictions),
    ).view(reference);
    assert.equal(view.readOnly, type === 'O');
    assert.equal(view.checkOption, type === 'V' ? 'CASCADED' : 'NONE');
    assert.equal(
      view.query,
      `SELECT 1 FROM DUAL${type === 'O' ? ' WITH READ ONLY' : type === 'V' ? ' WITH CHECK OPTION' : ''}`,
    );
  });
}

for (const field of [
  'READ_ONLY',
  'BEQUEATH',
  'EDITIONING_VIEW',
  'CONTAINER_DATA',
  'STATUS',
  'ORACLE_MAINTAINED',
]) {
  test(`catalog rejects unknown and null view ${field}`, async () => {
    for (const value of ['UNKNOWN', null]) {
      const connection = viewConnection('N', [], (sql, rows) => {
        if (sql.includes('FROM all_views')) rows[0][field] = value;
        return rows;
      });
      await assert.rejects(
        new OracleCatalog(connection).view(reference),
        new RegExp(`CATALOG_.*${field}`),
      );
    }
  });
}

test('catalog rejects ambiguous or inconsistent view restrictions', async () => {
  const restriction = {
    CONSTRAINT_NAME: 'R',
    CONSTRAINT_TYPE: 'O',
    STATUS: 'ENABLED',
  };
  for (const [flag, restrictions] of [
    ['Y', []],
    ['N', [restriction]],
    ['Y', [restriction, restriction]],
  ] as const) {
    await assert.rejects(
      new OracleCatalog(viewConnection(flag, [...restrictions])).view(
        reference,
      ),
      /CATALOG_(CARDINALITY|INCOMPLETE_METADATA)/,
    );
  }
});

test('catalog rejects missing and duplicate view columns and position gaps', async () => {
  for (const columns of [
    [],
    [{ COLUMN_NAME: 'X', POSITION: 2 }],
    [
      { COLUMN_NAME: 'X', POSITION: 1 },
      { COLUMN_NAME: 'X', POSITION: 2 },
    ],
  ]) {
    const connection = viewConnection('N', [], (sql, rows) =>
      sql.includes('FROM all_tab_columns') ? columns : rows,
    );
    await assert.rejects(
      new OracleCatalog(connection).view(reference),
      /CATALOG_(CARDINALITY|INCOMPLETE_METADATA)/,
    );
  }
});

test('catalog closes result sets when fetching fails', async () => {
  let closed = false;
  const connection = {
    async execute() {
      return {
        resultSet: {
          async getRows() {
            throw new Error('fetch failed');
          },
          async close() {
            closed = true;
          },
        },
      };
    },
  } as unknown as Connection;
  await assert.rejects(
    new OracleCatalog(connection).databaseVersion(),
    /fetch failed/,
  );
  assert.equal(closed, true);
});

test('catalog rejects missing identity metadata instead of emitting a sequence default', async () => {
  const connection = tableConnection((sql, rows) => {
    if (sql.includes('FROM dba_tab_cols')) rows[0].IDENTITY_COLUMN = 'YES';
    return rows;
  });
  await assert.rejects(
    new OracleCatalog(connection, 'dba').table(reference),
    /CATALOG_INCOMPLETE_METADATA.*IDENTITY_COLUMN/,
  );
});

test('catalog preserves null comments and rejects missing comment fields', async () => {
  const nullable = tableConnection((sql, rows) => {
    if (
      sql.includes('FROM dba_tab_comments') ||
      sql.includes('FROM dba_col_comments')
    )
      rows[0].COMMENTS = null;
    return rows;
  });
  const table = await new OracleCatalog(nullable, 'dba').table(reference);
  assert.equal(table.comment, null);
  assert.equal(table.columns[0].comment, null);
  const missing = tableConnection((sql, rows) => {
    if (sql.includes('FROM dba_col_comments')) delete rows[0].COMMENTS;
    return rows;
  });
  await assert.rejects(
    new OracleCatalog(missing, 'dba').table(reference),
    /CATALOG_INCOMPLETE_METADATA.*COMMENTS/,
  );
});

test('catalog does not truncate paged constraint rows and caches only decoded results', async () => {
  let calls = 0,
    closed = 0;
  const connection = {
    async execute() {
      calls++;
      let batch = 0;
      return {
        resultSet: {
          async getRows() {
            batch++;
            if (batch === 3) return [];
            // A late malformed row must still be observed after a full batch.
            const row = {
              OWNER: 'APP',
              CONSTRAINT_NAME: 'C',
              CONSTRAINT_TYPE: 'C',
              GENERATED: 'USER NAME',
              STATUS: 'ENABLED',
              VALIDATED: 'VALIDATED',
              DEFERRABLE: 'NOT DEFERRABLE',
              DEFERRED: 'IMMEDIATE',
              RELY: null,
              SEARCH_CONDITION: '1=1',
              INDEX_OWNER: null,
              INDEX_NAME: null,
              R_OWNER: null,
              R_CONSTRAINT_NAME: null,
              DELETE_RULE: null,
              PARENT_TABLE_NAME: null,
            };
            return batch === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  ...row,
                  CONSTRAINT_NAME: `C${index}`,
                }))
              : [{ ...row, STATUS: 'UNKNOWN' }];
          },
          async close() {
            closed++;
          },
        },
      };
    },
  } as unknown as Connection;
  const catalog = new OracleCatalog(connection);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      catalog.foreignKeys(reference),
      /CATALOG_UNKNOWN_VALUE.*STATUS/,
    );
  assert.equal(calls, 2);
  assert.equal(closed, 2);
});
