import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueReferences } from '../src/model.js';

test('unique references accepts an empty selection', () => {
  assert.deepEqual(uniqueReferences([]), []);
});

test('unique references retains the last duplicate without changing the input', () => {
  const first = { owner: 'APP', name: 'TABLE' };
  const last = { ...first };
  const references = [first, last];

  const result = uniqueReferences(references);

  assert.equal(result.length, 1);
  assert.equal(result[0], last);
  assert.equal(references.length, 2);
  assert.equal(references[0], first);
  assert.equal(references[1], last);
});

test('unique references has stable key ordering across input orders', () => {
  const expected = [
    { owner: 'APP', name: 'Z' },
    { owner: 'APP', name: 'a' },
    { owner: 'APP', name: 'é' },
    { owner: 'OTHER', name: 'A' },
  ];
  const reversed = [...expected].reverse();

  assert.deepEqual(uniqueReferences(reversed), expected);
  assert.deepEqual(uniqueReferences(expected), expected);
  assert.deepEqual(reversed, [...expected].reverse());
});

test('unique references distinguishes punctuation in owners and names', () => {
  const references = [
    { owner: 'A.B', name: 'C' },
    { owner: 'A', name: 'B.C' },
    { owner: 'A', name: 'B"C' },
  ];

  assert.deepEqual(uniqueReferences(references), [
    references[1],
    references[2],
    references[0],
  ]);
});

test('v6 rejects every previous document version and historical table roles', async () => {
  const { sourceFixture } = await import('./fixtures.js');
  const { sourceDocumentSchema, targetDocumentSchema, policySchema } =
    await import('../src/model.js');
  const { transformSource } = await import('../src/transform.js');
  const { generateSql } = await import('../src/generate.js');
  const source = sourceFixture();
  const target = transformSource(source, policySchema.parse({}));
  for (const formatVersion of [1, 2, 3, 4, 5]) {
    assert.throws(
      () => sourceDocumentSchema.parse({ ...source, formatVersion }),
      /re-extract/,
    );
    assert.throws(
      () =>
        transformSource(
          { ...source, formatVersion } as unknown as typeof source,
          policySchema.parse({}),
        ),
      /re-extract/,
    );
    assert.throws(
      () => targetDocumentSchema.parse({ ...target, formatVersion }),
      /re-extract/,
    );
    assert.throws(
      () => generateSql({ ...target, formatVersion }),
      /re-extract/,
    );
  }
  for (const role of ['direct-parent', 'view-dependency']) {
    assert.throws(() =>
      sourceDocumentSchema.parse({
        ...source,
        tables: [{ ...source.tables[0], role }],
      }),
    );
    assert.throws(() =>
      generateSql({ ...target, tables: [{ ...target.tables[0], role }] }),
    );
  }
});
