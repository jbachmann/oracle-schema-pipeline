import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionSchema,
  policySchema,
  sourceDocumentSchema,
} from '../src/model.js';
import { generateSql } from '../src/generate.js';
import { validateTarget } from '../src/validate.js';
import { programDeclaration } from '../src/programs.js';
import { program, programTarget } from './program-fixtures.js';
import { ordinaryTable } from './fixtures.js';
import { validatePrograms } from '../src/programs.js';

test('legacy selection/policy normalize strictly and v6 arrays remain mandatory', () => {
  assert.equal(
    selectionSchema.parse({ version: 2, tables: [{ owner: 'APP', name: 'T' }] })
      .version,
    3,
  );
  assert.equal(policySchema.parse({ version: 1 }).version, 2);
  assert.throws(() =>
    selectionSchema.parse({
      version: 2,
      procedures: [{ owner: 'APP', name: 'P' }],
    }),
  );
  assert.throws(() => policySchema.parse({ version: 1, objectGrants: [] }));
  for (const kind of [
    'procedures',
    'functions',
    'packages',
    'sequences',
    'synonyms',
  ])
    assert.equal(
      selectionSchema.parse({
        version: 3,
        [kind]: [{ owner: 'APP', name: 'X' }],
      }).version,
      3,
    );
  assert.throws(() => selectionSchema.parse({ version: 3 }));
  assert.throws(() =>
    sourceDocumentSchema.parse({
      ...programTarget(),
      kind: 'source',
      programUnits: undefined,
    }),
  );
});

test('program source binds the exact quoted header without rewriting literals or comments', () => {
  const unit = program(
    'Odd" Name',
    'PROCEDURE',
    '/* comment */ PROCEDURE "Odd"" Name" AS s VARCHAR2(100) := q\'[a\n/\nSET DEFINE ON]\'; BEGIN NULL; END;',
  );
  assert.equal(
    programDeclaration(unit).statement,
    'CREATE EDITIONABLE /* comment */ PROCEDURE "APP"."Odd"" Name" AS s VARCHAR2(100) := q\'[a\n/\nSET DEFINE ON]\'; BEGIN NULL; END;',
  );
  assert.throws(() =>
    programDeclaration({ ...unit, reference: { owner: 'APP', name: 'OTHER' } }),
  );
});

test('invalid, specialized, unselected, and incomplete programs fail independent generation', () => {
  const mutations = [
    (t: ReturnType<typeof programTarget>) => {
      t.programUnits[0].status = 'INVALID';
    },
    (t: ReturnType<typeof programTarget>) => {
      t.programUnits[0].sourceLines[0].text =
        'PROCEDURE OTHER AS BEGIN NULL; END;';
    },
    (t: ReturnType<typeof programTarget>) => {
      t.programUnits[0].sourceLines[0].line = 2;
    },
    (t: ReturnType<typeof programTarget>) => {
      t.targetProcedures = [];
    },
    (t: ReturnType<typeof programTarget>) => {
      t.programUnits[0].routineProperties!.pipelined = true;
    },
    (t: ReturnType<typeof programTarget>) => {
      t.programUnits[0].compilerSettings.plsqlImplicitConversionBool = null;
    },
  ];
  for (const mutate of mutations) {
    const target = programTarget();
    mutate(target);
    assert.throws(() => generateSql(target));
  }
});

test('wrapped code and mismatched declarations retain the specified diagnostic codes', () => {
  const target = programTarget();
  target.programUnits[0].sourceLines[0].text = 'PROCEDURE P wrapped abcd';
  assert.ok(
    validateTarget(target).some((item) => item.code === 'UNSUPPORTED_PROGRAM'),
  );
  target.programUnits[0].sourceLines[0].text =
    'PROCEDURE OTHER AS BEGIN NULL; END;';
  assert.ok(
    validateTarget(target).some(
      (item) => item.code === 'PROGRAM_SOURCE_IDENTITY',
    ),
  );
});

test('direct body-less package accepts constants but rejects routines and cursor declarations', () => {
  const target = programTarget();
  target.targetProcedures = [];
  target.targetPackages = [{ owner: 'APP', name: 'C' }];
  const spec = program(
    'C',
    'PACKAGE',
    'PACKAGE C AS n CONSTANT NUMBER := 1; END;',
  );
  spec.packageBodyPresent = false;
  target.programUnits = [spec];
  assert.equal(
    validateTarget(target).filter((d) => d.severity === 'error').length,
    0,
  );
  for (const declaration of ['PROCEDURE p;', 'CURSOR c RETURN NUMBER;']) {
    spec.sourceLines[0].text = `PACKAGE C AS ${declaration} END;`;
    assert.throws(() => generateSql(target), /PROGRAM_SELECTION_MISMATCH/);
  }
});

test('program dependencies require explicit objects and legal recursion does not cycle', () => {
  const target = programTarget();
  const unit = target.programUnits[0];
  unit.dependencies = [
    {
      reference: unit.reference,
      type: 'PROCEDURE',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  assert.doesNotThrow(() => generateSql(target));
  unit.dependencies.push({
    reference: { owner: 'APP', name: 'T' },
    type: 'TABLE',
    databaseLink: null,
    oracleMaintained: false,
  });
  assert.throws(() => generateSql(target), /MISSING_PROGRAM_DEPENDENCY/);
  target.tables = [ordinaryTable('APP', 'T')];
  target.targetTables = [target.tables[0].reference];
  const sql = generateSql(target);
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('-- Compile PROCEDURE'));
});

test('package member kind and overload metadata retain whole package selection', () => {
  const target = programTarget();
  target.targetProcedures = [{ owner: 'APP', package: 'A', name: 'P' }];
  const spec = program(
    'A',
    'PACKAGE',
    'PACKAGE A AS PROCEDURE P; PROCEDURE P(n NUMBER); FUNCTION F RETURN NUMBER; END;',
  );
  const props = target.programUnits[0].routineProperties!;
  spec.members = [
    {
      name: 'P',
      subprogramId: 1,
      overload: '1',
      kind: 'procedure',
      routineProperties: props,
    },
    {
      name: 'P',
      subprogramId: 2,
      overload: '2',
      kind: 'procedure',
      routineProperties: props,
    },
    {
      name: 'F',
      subprogramId: 3,
      overload: null,
      kind: 'function',
      routineProperties: props,
    },
  ];
  target.programUnits = [
    spec,
    program(
      'A',
      'PACKAGE BODY',
      'PACKAGE BODY A AS PROCEDURE P IS BEGIN NULL; END; END;',
    ),
  ];
  assert.deepEqual(validatePrograms(target), []);
  target.targetFunctions = [{ owner: 'APP', package: 'A', name: 'P' }];
  assert.ok(
    validatePrograms(target).some(
      (d) => d.code === 'PROGRAM_SELECTION_MISMATCH',
    ),
  );
});
