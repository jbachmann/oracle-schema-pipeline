import { test } from 'node:test';
import assert from 'node:assert/strict';
import { program, programTarget, sequence } from './program-fixtures.js';
import { ordinaryTable } from './fixtures.js';
import { generateSql } from '../src/generate.js';

test('function needing a table precedes its index without creating a false table cycle', () => {
  const target = programTarget();
  target.targetProcedures = [];
  const fn = program(
    'F',
    'FUNCTION',
    'FUNCTION F(n NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN n; END;',
  );
  fn.routineProperties!.deterministic = true;
  const table = ordinaryTable('APP', 'T');
  target.tables = [table];
  target.targetTables = [table.reference];
  fn.dependencies = [
    {
      reference: table.reference,
      type: 'TABLE',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  target.programUnits = [fn];
  target.targetFunctions = [fn.reference];
  table.indexes.push({
    ...structuredClone(table.indexes[0]),
    reference: { owner: 'APP', name: 'FI' },
    type: 'FUNCTION-BASED NORMAL',
    unique: false,
    keys: [{ column: null, expression: 'APP.F(ID)', direction: 'ASC' }],
    dependencies: [
      { reference: fn.reference, type: 'FUNCTION', databaseLink: null },
    ],
  });
  const sql = generateSql(target);
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('-- Compile FUNCTION'));
  assert.ok(
    sql.indexOf('-- Compile FUNCTION') < sql.indexOf('CREATE INDEX "APP"."FI"'),
  );
  table.dependencies.push({
    reference: fn.reference,
    type: 'FUNCTION',
    databaseLink: null,
  });
  assert.throws(() => generateSql(target), /OBJECT_DEPENDENCY_CYCLE/);
});

test('selected sequence and declared direct grant precede dependent table creation', () => {
  const target = programTarget();
  const table = ordinaryTable('OTHER', 'T'),
    seq = sequence();
  table.dependencies = [
    { reference: seq.reference, type: 'SEQUENCE', databaseLink: null },
  ];
  table.columns[1].defaultExpression = 'APP.S.NEXTVAL';
  target.tables = [table];
  target.targetTables = [table.reference];
  target.sequences = [seq];
  target.targetSequences = [seq.reference];
  target.policy.objectGrants = [
    {
      reference: seq.reference,
      type: 'SEQUENCE',
      grantee: 'OTHER',
      privileges: ['SELECT', 'SELECT'],
    },
  ];
  const sql = generateSql(target);
  assert.ok(sql.indexOf('CREATE SEQUENCE') < sql.indexOf('GRANT SELECT'));
  assert.ok(sql.indexOf('GRANT SELECT') < sql.indexOf('CREATE TABLE'));
  assert.equal(sql.match(/GRANT SELECT ON/g)?.length, 1);
});

test('mutually calling package bodies compile against specifications and function indexes follow bodies', () => {
  const target = programTarget();
  target.targetProcedures = [];
  target.programUnits = [];
  target.targetPackages = [];
  for (const name of ['A', 'B']) {
    const spec = program(
      name,
      'PACKAGE',
      `PACKAGE ${name} AS PROCEDURE p; END;`,
    );
    const body = program(
      name,
      'PACKAGE BODY',
      `PACKAGE BODY ${name} AS PROCEDURE p IS BEGIN NULL; END; END;`,
    );
    body.dependencies = [
      {
        reference: { owner: 'APP', name: name === 'A' ? 'B' : 'A' },
        type: 'PACKAGE',
        databaseLink: null,
        oracleMaintained: false,
      },
    ];
    target.programUnits.push(spec, body);
    target.targetPackages.push(spec.reference);
  }
  assert.doesNotThrow(() => generateSql(target));
  const table = ordinaryTable('APP', 'T');
  target.tables = [table];
  target.targetTables = [table.reference];
  table.indexes.push({
    ...table.indexes[0],
    reference: { owner: 'APP', name: 'FI' },
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    keys: [{ column: null, expression: 'APP.A.F(ID)', direction: 'ASC' }],
    dependencies: [
      {
        reference: { owner: 'APP', name: 'A' },
        type: 'PACKAGE',
        databaseLink: null,
      },
    ],
  });
  const sql = generateSql(target);
  assert.ok(
    sql.indexOf('-- Compile PACKAGE BODY "APP"."A"') <
      sql.indexOf('CREATE INDEX "APP"."FI"'),
  );
});

test('mixed SQL is deterministic under shuffled definitions, roots, and dependencies', () => {
  const target = programTarget();
  const second = program('Q');
  target.programUnits.push(second);
  target.targetProcedures.push(second.reference);
  target.sequences = [
    sequence(),
    { ...sequence(), reference: { owner: 'APP', name: 'OTHER_S' } },
  ];
  target.targetSequences = target.sequences.map((item) => item.reference);
  const expected = generateSql(target);
  target.programUnits.reverse();
  target.targetProcedures.reverse();
  target.sequences.reverse();
  target.targetSequences.reverse();
  assert.equal(generateSql(target), expected);
});
