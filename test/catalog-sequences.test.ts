import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { CatalogReader } from '../src/catalog-reader.js';
import { readSequences } from '../src/catalog-sequences.js';

test('sequence reader binds exact identities and decodes decimal text without numeric conversion', async () => {
  const reference = { owner: 'Owner "Ω', name: 'Seq Name' };
  let closed = false;
  const row = {
    MIN_VALUE: '-999999999999999999999999999',
    MAX_VALUE: '-1',
    INCREMENT_BY: '-2',
    CACHE_SIZE: '0',
    LAST_NUMBER: '-9999999999999999999999999999',
    CYCLE_FLAG: 'N',
    ORDER_FLAG: 'N',
    SCALE_FLAG: 'N',
    EXTEND_FLAG: 'N',
    SHARDED_FLAG: 'N',
    SESSION_FLAG: 'N',
    KEEP_VALUE: 'Y',
    SHARING: 'NONE',
    ORACLE_MAINTAINED: 'N',
    OBJECT_MAINTAINED: 'N',
    GENERATED: 'N',
    IDENTITY_COUNT: 0,
  };
  const connection = {
    async execute(sql: string, binds: unknown) {
      assert.match(sql, /TO_CHAR\(s.MIN_VALUE/);
      assert.ok(!sql.includes(reference.owner));
      assert.ok(!sql.includes('NEXTVAL'));
      assert.ok(!sql.includes('CURRVAL'));
      assert.deepEqual(binds, { owner: reference.owner, name: reference.name });
      let read = false;
      return {
        resultSet: {
          async getRows() {
            if (read) return [];
            read = true;
            return [row];
          },
          async close() {
            closed = true;
          },
        },
      };
    },
  } as unknown as Connection;
  const [sequence] = await readSequences(new CatalogReader(connection), [
    reference,
  ]);
  assert.equal(sequence.lastNumber, row.LAST_NUMBER);
  assert.equal(sequence.minValue, row.MIN_VALUE);
  assert.equal(sequence.keep, true);
  assert.ok(closed);
  row.MAX_VALUE = '1e28';
  await assert.rejects(
    readSequences(new CatalogReader(connection), [reference]),
    /CATALOG_INCOMPLETE_METADATA/,
  );
});
