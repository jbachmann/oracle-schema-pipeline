import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'oracledb';
import { CatalogReader } from '../src/catalog-reader.js';
import {
  readSynonyms,
  readSynonymResolution,
} from '../src/catalog-synonyms.js';

test('synonym reader retains immediate links, resolves external chains, and closes failed decodes', async () => {
  let opens = 0,
    closes = 0,
    cyclic = false,
    hidden = false;
  const connection = {
    async execute(sql: string, binds: { owner: string; name: string }) {
      assert.match(sql, /^SELECT /);
      assert.ok(sql.includes(':owner') && sql.includes(':name'));
      assert.ok(!sql.includes('DBMS_METADATA'));
      opens++;
      let fetched = false;
      return {
        resultSet: {
          async getRows() {
            if (fetched) return [];
            fetched = true;
            return [
              {
                TABLE_OWNER: 'APP',
                TABLE_NAME: binds.name === 'A' ? 'B' : cyclic ? 'A' : 'T',
                DB_LINK: null,
                EDITIONABLE: 'Y',
                EDITION_NAME: null,
                SHARING: 'NONE',
                TARGET_TYPE: hidden
                  ? null
                  : binds.name === 'A' || cyclic
                    ? 'SYNONYM'
                    : 'TABLE',
              },
            ];
          },
          async close() {
            closes++;
          },
        },
      };
    },
  } as unknown as Connection;
  const reader = new CatalogReader(connection),
    reference = { owner: 'APP', name: 'A' };
  assert.equal((await readSynonyms(reader, [reference]))[0].target.name, 'B');
  const resolution = await readSynonymResolution(reader, reference);
  assert.deepEqual(
    resolution.links.map((link) => link.reference.name),
    ['A', 'B'],
  );
  assert.equal(resolution.terminal.reference.name, 'T');
  cyclic = true;
  await assert.rejects(
    readSynonymResolution(reader, reference),
    /Cyclic synonym chain/,
  );
  hidden = true;
  await assert.rejects(
    readSynonyms(reader, [reference]),
    /CATALOG_INCOMPLETE_METADATA/,
  );
  assert.equal(opens, closes);
});
