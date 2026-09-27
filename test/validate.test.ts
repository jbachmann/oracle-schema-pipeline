import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policySchema } from '../src/model.js';
import { validateTarget } from '../src/validate.js';
import { transformSource } from '../src/transform.js';
import { ordinaryTable, sourceFixture } from './fixtures.js';

test('backing indexes must match every constraint column in order', () => {
  for (const columns of [
    ['TENANT_ID', 'ID'],
    ['ID', 'TENANT_ID'],
    ['TENANT_ID'],
    ['TENANT_ID', 'ID', 'TENANT_ID'],
    [null, 'ID'],
  ]) {
    const target = transformSource(sourceFixture(), policySchema.parse({}));
    target.tables[0].indexes[0].keys = columns.map((column) => ({
      column,
      expression: column === null ? 'TENANT_ID + 1' : null,
      direction: 'ASC',
    }));
    assert.equal(
      validateTarget(target).some(
        (d) => d.code === 'UNSUPPORTED_BACKING_INDEX',
      ),
      columns.join(',') !== 'TENANT_ID,ID',
    );
  }
});

test('index keys require exactly one non-null column or expression', () => {
  for (const [column, expression, invalid] of [
    ['TENANT_ID', null, false],
    [null, 'TENANT_ID + 1', false],
    [null, null, true],
    ['TENANT_ID', 'TENANT_ID + 1', true],
    ['', null, false],
    [null, '', false],
  ] as const) {
    const target = transformSource(sourceFixture(), policySchema.parse({}));
    target.tables[0].indexes[0].keys[0] = {
      column,
      expression,
      direction: 'ASC',
    };
    assert.equal(
      validateTarget(target).some((d) => d.code === 'INVALID_INDEX_KEY'),
      invalid,
    );
  }
});

test('duplicate index and constraint names are tracked across tables within each schema', () => {
  for (const owner of ['APP', 'OTHER']) {
    const source = sourceFixture();
    const first = ordinaryTable('APP', 'FIRST');
    const second = ordinaryTable(owner, 'FIRST');
    second.reference.name = 'SECOND';
    source.tables = [first, second];
    source.targetTables = source.tables.map((table) => table.reference);
    const target = transformSource(source, policySchema.parse({}));
    const expected =
      owner === 'APP'
        ? [
            {
              severity: 'error',
              code: 'DUPLICATE_INDEX',
              object: '"APP"."PK_FIRST"',
              message: 'Index names must be unique within their schema.',
            },
            {
              severity: 'error',
              code: 'DUPLICATE_CONSTRAINT',
              object: '"APP"."SECOND"/PK_FIRST',
              message: 'Constraint names must be unique within a schema.',
            },
          ]
        : [];
    assert.deepEqual(validateTarget(target), expected);
    target.diagnostics.push(...validateTarget(target));
    assert.deepEqual(validateTarget(target), expected);
  }
});
