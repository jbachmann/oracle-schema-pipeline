import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
const ref = { owner: 'APP', name: 'A' };
const object = (OBJECT_TYPE: string) => ({
  OBJECT_TYPE,
  ORACLE_MAINTAINED: 'N',
  SHARING: 'NONE',
  EDITION_NAME: null,
  EDITIONABLE: 'Y',
});
const mapping = (TABLE_NAME = 'T') => ({
  TABLE_OWNER: 'APP',
  TABLE_NAME,
  DB_LINK: null,
});
function transport(facts: Record<string, readonly unknown[]>, dba = false) {
  const queries: string[] = [];
  let closed = 0;
  return {
    queries,
    closed: () => closed,
    catalog: new OracleCatalog(
      {
        async execute(sql: string, binds: { name: string; owner: string }) {
          queries.push(sql);
          assert.match(sql, /^SELECT/);
          const key = `${binds.owner}.${binds.name}:${sql.includes('_synonyms') ? 'mapping' : 'object'}`;
          let rows = facts[key] ?? [];
          return {
            resultSet: {
              async getRows() {
                const value = rows;
                rows = [];
                return value;
              },
              async close() {
                closed++;
              },
            },
          };
        },
      } as unknown as Connection,
      dba ? 'dba' : 'all',
    ),
  };
}
const facts = () => ({
  'APP.A:object': [object('SYNONYM')],
  'APP.A:mapping': [mapping()],
  'APP.T:object': [object('TABLE')],
});
test('catalog binds exact references and captures complete local mapping', async () => {
  const t = transport(facts());
  const s = await t.catalog.synonym(ref);
  assert.deepEqual(s.target, { owner: 'APP', name: 'T' });
  assert.deepEqual(s.resolution, [
    { reference: s.target, type: 'TABLE', target: null },
  ]);
  assert.equal(t.closed(), t.queries.length);
  assert.ok(t.queries.every((sql) => !sql.includes('APP')));
});
for (const [name, patch, code] of [
  ['missing selection', { 'APP.A:object': [] }, 'SYNONYM_METADATA_UNAVAILABLE'],
  ['missing mapping', { 'APP.A:mapping': [] }, 'SYNONYM_METADATA_UNAVAILABLE'],
  ['invisible target', { 'APP.T:object': [] }, 'UNRESOLVED_SYNONYM_TARGET'],
  [
    'remote',
    { 'APP.A:mapping': [{ ...mapping(), DB_LINK: 'SECRET_LINK' }] },
    'UNSUPPORTED_SYNONYM',
  ],
  ['loop', { 'APP.A:mapping': [mapping('A')] }, 'SYNONYM_CYCLE'],
  [
    'unsupported type',
    { 'APP.T:object': [object('TYPE')] },
    'UNSUPPORTED_SYNONYM',
  ],
  [
    'Oracle maintained',
    { 'APP.A:object': [{ ...object('SYNONYM'), ORACLE_MAINTAINED: 'Y' }] },
    'UNSUPPORTED_SYNONYM',
  ],
  [
    'common',
    { 'APP.A:object': [{ ...object('SYNONYM'), SHARING: 'METADATA LINK' }] },
    'UNSUPPORTED_SYNONYM',
  ],
  [
    'edition',
    { 'APP.A:object': [{ ...object('SYNONYM'), EDITION_NAME: 'V1' }] },
    'UNSUPPORTED_SYNONYM',
  ],
  [
    'unknown flag',
    { 'APP.A:object': [{ ...object('SYNONYM'), EDITIONABLE: '?' }] },
    'CATALOG_UNKNOWN_VALUE',
  ],
] as const)
  test(`synonym catalog rejects ${name}`, async () => {
    const t = transport({ ...facts(), ...patch });
    await assert.rejects(t.catalog.synonym(ref), new RegExp(code));
    assert.equal(t.closed(), t.queries.length);
  });
test('DBA visibility resolves PUBLIC fallback but ALL scope does not guess from absence', async () => {
  const data = {
    ...facts(),
    'APP.A:mapping': [mapping('B')],
    'PUBLIC.B:object': [object('SYNONYM')],
    'PUBLIC.B:mapping': [mapping()],
  };
  const t = transport(data, true);
  const s = await t.catalog.synonym(ref);
  assert.equal(s.resolution[0].reference.owner, 'PUBLIC');
  await assert.rejects(
    transport(data).catalog.synonym(ref),
    /UNRESOLVED_SYNONYM_TARGET/,
  );
});

test('remote mappings with omitted owners still report unsupported links', async () => {
  const t = transport({
    ...facts(),
    'APP.A:mapping': [{ ...mapping(), TABLE_OWNER: null, DB_LINK: 'LINK' }],
  });
  await assert.rejects(t.catalog.synonym(ref), /UNSUPPORTED_SYNONYM/);
});
