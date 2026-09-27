import { policySchema } from '../src/model.js';
import { transformSource } from '../src/transform.js';
import {
  enabledState,
  numberColumn,
  ordinaryView,
  sourceFixture,
} from './fixtures.js';

export function preparationFixture() {
  const source = sourceFixture();
  const table = source.tables[0];
  table.comment = "Owner's table";
  table.columns[0].comment = 'Unicode Ω\nsecond line';
  table.columns[0].defaultExpression = ' 1 ';
  table.columns[0].defaultOnNull = true;
  table.columns[1].identity = {
    generation: 'BY DEFAULT',
    options:
      'START WITH: 1, INCREMENT BY: 1, MAX_VALUE: 9999999999999999999999999999, MIN_VALUE: 1, CYCLE_FLAG: N, CACHE_SIZE: 20, ORDER_FLAG: N',
  };
  const virtual = numberColumn('COMPUTED', 3);
  virtual.nullable = true;
  virtual.virtual = true;
  virtual.invisible = true;
  virtual.defaultExpression = '"ID" + 1';
  table.columns.push(virtual);
  table.constraints.push(
    {
      kind: 'check',
      name: 'CK_ID',
      generatedName: false,
      expression: '"ID" > 0',
      state: { ...enabledState },
    },
    {
      kind: 'not-null',
      name: 'NN_TENANT',
      generatedName: false,
      column: 'TENANT_ID',
      state: { ...enabledState },
    },
  );
  const key = table.constraints[0];
  if (key.kind === 'primary-key') {
    key.backingIndex = { owner: 'APP', name: 'IX"$&$1' };
    table.indexes[0].reference = { ...key.backingIndex };
  }
  const foreignKey = table.constraints.find(
    (constraint) => constraint.kind === 'foreign-key',
  )!;
  table.constraints.push({ ...structuredClone(foreignKey), name: 'FK_SECOND' });
  const base = ordinaryView('BASE');
  base.role = 'dependency';
  base.query = ' SELECT "ID" FROM "APP"."CHILD" ';
  base.dependencies = [
    { reference: table.reference, type: 'TABLE', databaseLink: null },
  ];
  const view = ordinaryView('REPORT');
  view.reference.owner = 'REPORT_USER';
  view.bequeath = 'CURRENT_USER';
  view.query = ' SELECT "ID" FROM "REPORTING"."BASE" ';
  view.dependencies = [
    { reference: base.reference, type: 'VIEW', databaseLink: null },
    { reference: table.reference, type: 'TABLE', databaseLink: null },
  ];
  const second = {
    ...structuredClone(view),
    reference: { owner: 'REPORT_USER', name: 'SECOND' },
  };
  source.views = [second, view, base];
  source.targetViews = [view.reference, second.reference];
  return transformSource(source, policySchema.parse({ createSchemas: true }));
}

export function failedPreparationFixture() {
  const target = preparationFixture();
  const table = target.tables[0];
  table.columns[0].dataType.name = 'UNSUPPORTED';
  table.columns[1].identity!.options = 'UNKNOWN: 1';
  table.columns[0].comment = '';
  table.comment = '';
  table.indexes[0].keys[0] = {
    column: null,
    expression: null,
    direction: 'ASC',
  };
  target.views[0].query = `SELECT '${'Ω'.repeat(1200)}' FROM DUAL`;
  return target;
}
