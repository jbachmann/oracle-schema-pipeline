import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateSql } from '../src/generate.js';
import { prepareSql } from '../src/prepare.js';
import { analyzeTarget } from '../src/semantic.js';
import { validateTarget } from '../src/validate.js';
import type { Diagnostic } from '../src/model.js';
import type { SqlPreparation } from '../src/sql-preparation.js';
import {
  preparationFixture,
  failedPreparationFixture,
} from './preparation-fixtures.js';

// Preparation regression snapshot, updated for conditional schema creation.
const expected: Record<
  string,
  { preparation: SqlPreparation; diagnostics: Diagnostic[] }
> = JSON.parse(
  readFileSync(new URL('./fixtures/preparation.json', import.meta.url), 'utf8'),
);

for (const [name, fixture] of [
  ['valid', preparationFixture],
  ['invalid', failedPreparationFixture],
] as const) {
  test(`preparation preserves ${name} SQL, diagnostic order, and input metadata`, () => {
    const target = fixture();
    const analysis = analyzeTarget(target);
    const before = structuredClone({ target, analysis });
    assert.deepEqual(prepareSql(target, analysis), expected[name].preparation);
    assert.deepEqual(validateTarget(target), expected[name].diagnostics);
    assert.deepEqual({ target, analysis }, before);
    if (name === 'valid') {
      assert.equal(
        generateSql(target),
        expected[name].preparation.operations
          .map(({ sql }) => sql)
          .join('\n\n') + '\n',
      );
    } else {
      assert.throws(() => generateSql(target), /UNSUPPORTED_TYPE/);
    }
  });
}

test('preparation orders tables, columns, constraints, and views independently of metadata order', () => {
  const target = preparationFixture();
  target.tables.reverse();
  target.views.reverse();
  for (const table of target.tables) {
    table.columns.reverse();
    table.constraints.reverse();
    table.indexes.reverse();
  }
  for (const view of target.views) {
    view.dependencies.reverse();
  }
  assert.deepEqual(
    prepareSql(target, analyzeTarget(target)),
    expected.valid.preparation,
  );
});

test('constraint states place backing indexes before enablement and preserve literal names', () => {
  for (const kind of ['primary-key', 'unique'] as const) {
    for (const backingIndex of [null, { owner: 'APP', name: 'IX"$&$1' }]) {
      for (const [deferrable, initiallyDeferred, deferral] of [
        [false, false, 'NOT DEFERRABLE'],
        [false, true, 'NOT DEFERRABLE'],
        [true, false, 'DEFERRABLE INITIALLY IMMEDIATE'],
        [true, true, 'DEFERRABLE INITIALLY DEFERRED'],
      ] as const) {
        for (const rely of [false, true]) {
          for (const enabled of [false, true]) {
            for (const validated of [false, true]) {
              const target = preparationFixture();
              const table = target.tables[0];
              table.constraints = [
                {
                  kind,
                  name: 'KEY',
                  generatedName: false,
                  columns: ['ID'],
                  backingIndex,
                  state: {
                    deferrable,
                    initiallyDeferred,
                    rely,
                    enabled,
                    validated,
                  },
                },
              ];
              const { operations } = prepareSql(target, analyzeTarget(target));
              const sql = operations.find(
                ({ object }) => object === '"APP"."CHILD"/KEY',
              )?.sql;
              const keyKind = kind === 'primary-key' ? 'PRIMARY KEY' : 'UNIQUE';
              const indexClause = backingIndex
                ? ' USING INDEX "APP"."IX""$&$1"'
                : '';
              assert.equal(
                sql,
                `ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "KEY" ${keyKind} ("ID") ${deferral}${rely ? ' RELY' : ''}${indexClause} ${enabled ? 'ENABLE' : 'DISABLE'} ${validated ? 'VALIDATE' : 'NOVALIDATE'};`,
              );
            }
          }
        }
      }
    }
  }
});

test('check and not-null states omit deferral even when metadata requests it', () => {
  const target = preparationFixture();
  for (const constraint of target.tables[0].constraints) {
    if (constraint.kind === 'check' || constraint.kind === 'not-null') {
      constraint.state = {
        deferrable: true,
        initiallyDeferred: true,
        rely: true,
        enabled: false,
        validated: false,
      };
    }
  }
  const { operations } = prepareSql(target, analyzeTarget(target));
  assert.ok(
    operations.some(({ sql }) =>
      sql.includes('CONSTRAINT "NN_TENANT" NOT NULL RELY DISABLE NOVALIDATE'),
    ),
  );
  assert.ok(
    operations.some(({ sql }) =>
      sql.endsWith('CHECK ("ID" > 0) RELY DISABLE NOVALIDATE;'),
    ),
  );
});
