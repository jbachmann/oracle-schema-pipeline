import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparableExpression as compare } from './helpers/sql-comparison.js';

test('comparison ignores presentation whitespace and enclosing parentheses', () => {
  assert.equal(compare(' (( "X" + 1 )) '), compare('"X"+1'));
  assert.notEqual(compare('(A)+(B)'), compare('A+B'));
  assert.equal(compare(null), null);
});

test('literal spaces, escaped quotes and parentheses remain significant', () => {
  for (const [left, right] of [
    ["'a  b'", "'a b'"],
    ["'it''s  (fine)'", "'it''s (fine)'"],
    ["q'[a  ) '' b]'", "q'[a ) '' b]'"],
    ["nq'[a '  ) ' b]'", "nq'[a ' ) ' b]'"],
    ['"a  b"', '"a b"'],
    ['A B', 'AB'],
    ['A | | B', 'A || B'],
    ['A /* two  spaces */', 'A /* two spaces */'],
  ])
    assert.notEqual(compare(left), compare(right));
  for (const literal of ["')('", "'it''s )'", "q'{) (}'", '"odd)name"'])
    assert.equal(compare(`((${literal}))`), compare(literal));
  assert.notEqual(compare('A -- comment\n+ B'), compare('A -- comment + B'));
  assert.throws(() => compare("'unfinished"), /Unterminated/);
});
