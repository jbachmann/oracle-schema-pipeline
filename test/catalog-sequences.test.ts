import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { sequenceError } from '../src/sequences.js';
const reference = { owner: 'APP', name: 'S' };
const facts = {
  MIN_VALUE: '1',
  MAX_VALUE: '9999999999999999999999999999',
  INCREMENT_BY: '3',
  CACHE_SIZE: '20',
  CYCLE_FLAG: 'N',
  ORDER_FLAG: 'N',
  SCALE_FLAG: 'N',
  EXTEND_FLAG: 'N',
  SHARDED_FLAG: 'N',
  SESSION_FLAG: 'N',
  KEEP_VALUE: 'N',
  ORACLE_MAINTAINED: 'N',
  SHARING: 'NONE',
  IDENTITY_COUNT: 0,
};
function connection(rows: unknown[]) {
  let closed = 0;
  const sqls: string[] = [];
  return {
    sqls,
    closed: () => closed,
    connection: {
      async execute(sql: string, binds: unknown) {
        sqls.push(sql);
        let result = sql.includes('AS complete') ? [{ COMPLETE: 1 }] : rows;
        assert.ok(binds);
        return {
          resultSet: {
            async getRows() {
              const batch = result;
              result = [];
              return batch;
            },
            async close() {
              closed++;
            },
          },
        };
      },
    } as unknown as Connection,
  };
}

test('sequence catalog preserves numeric text and never reads source position', async () => {
  const transport = connection([facts]);
  const sequence = await new OracleCatalog(transport.connection).sequence(
    reference,
  );
  assert.equal(sequence.maxValue, facts.MAX_VALUE);
  assert.equal(sequenceError(sequence), undefined);
  assert.ok(
    transport.sqls.some((sql) => sql.includes("to_char(s.max_value, 'TM9')")),
  );
  assert.ok(transport.sqls.every((sql) => !/LAST_NUMBER|NEXTVAL/i.test(sql)));
  assert.equal(transport.closed(), 2);
});
for (const [name, rows, code] of [
  ['missing', [], 'CATALOG_CARDINALITY'],
  ['duplicate', [facts, facts], 'CATALOG_CARDINALITY'],
  ['unknown flag', [{ ...facts, SCALE_FLAG: '?' }], 'CATALOG_UNKNOWN_VALUE'],
  [
    'numeric driver value',
    [{ ...facts, MAX_VALUE: 9999999999999999999999999999 }],
    'CATALOG_INCOMPLETE_METADATA',
  ],
  [
    'null bound',
    [{ ...facts, MIN_VALUE: null }],
    'CATALOG_INCOMPLETE_METADATA',
  ],
  ['identity sequence', [{ ...facts, IDENTITY_COUNT: 1 }], 'INVALID_SEQUENCE'],
] as const) {
  test(`sequence catalog rejects ${name}`, async () => {
    const transport = connection([...rows]);
    await assert.rejects(
      new OracleCatalog(transport.connection).sequence(reference),
      new RegExp(code),
    );
    assert.equal(transport.closed(), 2);
  });
}

test('shared and Oracle-maintained variants are retained as blocking facts', async () => {
  for (const row of [
    { ...facts, ORACLE_MAINTAINED: 'Y' },
    { ...facts, SHARING: 'DATA LINK' },
  ]) {
    const sequence = await new OracleCatalog(
      connection([row]).connection,
    ).sequence(reference);
    assert.ok(sequence.unsupportedFeatures.length);
  }
});
