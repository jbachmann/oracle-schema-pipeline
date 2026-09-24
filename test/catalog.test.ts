import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';

test('Oracle adapter reads full LONG expressions, ordered keys and actual index expressions', async () => {
  const longPredicate =
    '"VALUE" >= 0' + ' /* preserved metadata */'.repeat(2000);
  const statements: string[] = [];
  const connection = {
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
      let fetched = false;
      return {
        resultSet: {
          async getRows() {
            if (fetched) return [];
            fetched = true;
            return rows;
          },
          async close() {},
        },
      };
    },
  } as unknown as Connection;
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
      /Missing or inaccessible table/,
    );
    const other = scope === 'all' ? 'dba_' : 'all_';
    assert.ok(statements.length > 0);
    assert.ok(statements.every((sql) => !sql.toLowerCase().includes(other)));
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));
  }
});
