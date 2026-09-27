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
