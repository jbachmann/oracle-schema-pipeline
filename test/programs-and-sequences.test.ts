import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFixture, ordinaryTable, ordinaryView } from './fixtures.js';
import {
  selectionSchema,
  sourceDocumentSchema,
  policySchema,
  type ProgramDefinition,
  type SequenceDefinition,
} from '../src/model.js';
import { extractSource, type SourceCatalog } from '../src/extract.js';
import { transformSource } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { validateTarget } from '../src/validate.js';
import { schemaOwners } from '../src/schema-owners.js';
import { buildDictionaryWorkbook } from '../src/dictionary.js';
import {
  verificationChecks,
  generatedReplay,
} from '../scripts/compose-destination.js';
import { sequenceError } from '../src/sequences.js';

const reference = (name: string, owner = 'APP') => ({ owner, name });
const sequence = (): SequenceDefinition => ({
  reference: reference('S'),
  minValue: '1',
  maxValue: '9999999999999999999999999999',
  incrementBy: '1',
  cacheSize: '0',
  cycle: false,
  order: false,
  scale: false,
  extend: false,
  sharded: false,
  session: false,
  keep: false,
  unsupportedFeatures: [],
});
const program = (name = 'F'): ProgramDefinition => ({
  reference: reference(name),
  kind: 'FUNCTION',
  units: [
    {
      type: 'FUNCTION',
      ddl: `\nCREATE OR REPLACE FUNCTION "APP"."${name}" RETURN NUMBER AS\n-- é; comment /\nBEGIN\n\nRETURN 1; END;\n/\n`,
      status: 'VALID',
      dependencies: [],
    },
  ],
  unsupportedFeatures: [],
});
function source() {
  return {
    ...sourceFixture(),
    targetTables: [],
    tables: [],
    targetFunctions: [reference('F')],
    programs: [program()],
    targetSequences: [reference('S')],
    sequences: [sequence()],
  };
}
const target = () => transformSource(source(), policySchema.parse({}));

test('selection accepts each new kind alone, legacy input and exact names, but rejects empty and unknown keys', () => {
  for (const kind of [
    'tables',
    'views',
    'packages',
    'procedures',
    'functions',
    'sequences',
  ]) {
    const selected = selectionSchema.parse({
      version: 2,
      [kind]: [reference('Odd "é')],
    });
    assert.deepEqual(selected[kind as keyof typeof selected], [
      reference('Odd "é'),
    ]);
  }
  assert.throws(
    () => selectionSchema.parse({ version: 2 }),
    /At least one object/,
  );
  assert.throws(
    () =>
      selectionSchema.parse({
        version: 2,
        functions: [reference('F')],
        triggers: [],
      }),
    /Unrecognized/,
  );
  assert.throws(
    () => sourceDocumentSchema.parse({ ...source(), formatVersion: 5 }),
    /re-extract/,
  );
  const missing = { ...source(), programs: undefined };
  assert.throws(() => sourceDocumentSchema.parse(missing), /Required/);
});

test('extraction deduplicates each kind, rejects namespace collisions and never expands program dependencies', async () => {
  const seen: string[] = [];
  const catalog: SourceCatalog = {
    databaseVersion: async () => '23',
    foreignKeys: async () => {
      throw new Error('Unexpected table');
    },
    table: async () => {
      throw new Error('Unexpected table');
    },
    prerequisites: async () => [],
    program: async (ref, kind) => {
      seen.push(ref.name);
      return { ...program(ref.name), kind };
    },
    sequence: async () => sequence(),
  };
  const extracted = await extractSource(catalog, {
    version: 2,
    functions: [reference('F'), reference('F')],
    sequences: [reference('S')],
  });
  assert.deepEqual(seen, ['F']);
  assert.equal(extracted.tables.length, 0);
  await assert.rejects(
    extractSource(catalog, {
      version: 2,
      functions: [reference('F')],
      sequences: [reference('F')],
    }),
    /OBJECT_NAME_COLLISION/,
  );
  await assert.rejects(
    extractSource(
      { ...catalog, program: undefined },
      { version: 2, functions: [reference('F')] },
    ),
    /PROGRAM_METADATA_UNAVAILABLE/,
  );
});

test('DDL is unchanged, sequence reset is explicit, and owners/verification include new definitions', () => {
  const document = target(),
    before = structuredClone(document);
  const sql = generateSql(document);
  assert.ok(sql.includes(document.programs[0].units[0].ddl));
  assert.match(sql, /START WITH 1 INCREMENT BY 1/);
  assert.match(sql, /OSP_PROGRAM_INVALID/);
  assert.match(sql, /FOR pass IN 1\.\.2 LOOP/);
  assert.ok(
    sql.indexOf('CREATE SEQUENCE') < sql.indexOf('CREATE OR REPLACE FUNCTION'),
  );
  assert.equal(
    document.diagnostics.filter((d) => d.code === 'SEQUENCE_POSITION_RESET')
      .length,
    1,
  );
  assert.deepEqual(schemaOwners(document), ['APP']);
  assert.match(verificationChecks(document), /object_type='FUNCTION'/);
  assert.match(verificationChecks(document), /object_type='SEQUENCE'/);
  assert.ok(generatedReplay(sql).includes(document.programs[0].units[0].ddl));
  assert.deepEqual(document, before);
  assert.doesNotThrow(() => buildDictionaryWorkbook(source()));
});

test('units, target lists, unsupported metadata and SQL byte limits fail closed without exposing DDL', () => {
  for (const [mutate, code] of [
    [
      (d: ReturnType<typeof target>) =>
        d.programs[0].units.push(d.programs[0].units[0]),
      'INVALID_PROGRAM_UNITS',
    ],
    [
      (d: ReturnType<typeof target>) => {
        d.programs[0].kind = 'PACKAGE';
        d.targetPackages = d.targetFunctions;
        d.targetFunctions = [];
      },
      'INVALID_PROGRAM_UNITS',
    ],
    [
      (d: ReturnType<typeof target>) => {
        d.targetFunctions = [];
      },
      'MISSING_TARGET',
    ],
    [
      (d: ReturnType<typeof target>) => {
        d.programs[0].unsupportedFeatures = ['unsupported'];
      },
      'UNSUPPORTED_FEATURE',
    ],
    [
      (d: ReturnType<typeof target>) => {
        d.programs[0].units[0].ddl = 'secret' + 'é'.repeat(1200);
      },
      'SQL_LINE_LIMIT',
    ],
  ] as const) {
    const d = target();
    mutate(d);
    assert.throws(() => generateSql(d), new RegExp(code));
    assert.ok(!JSON.stringify(validateTarget(d)).includes('secret'));
  }
});

test('exact sequence validation handles descending and large bounds, and rejects invalid options', () => {
  const d = target();
  Object.assign(d.sequences[0], {
    minValue: '-999',
    maxValue: '-1',
    incrementBy: '-3',
    cycle: true,
  });
  assert.match(generateSql(d), /START WITH -1 INCREMENT BY -3/);
  for (const change of [
    { incrementBy: '0' },
    { minValue: '999', maxValue: '1' },
    { cacheSize: '1' },
    { cacheSize: '-2' },
    { cycle: true, cacheSize: '9999999999999999999999999999' },
  ]) {
    assert.ok(sequenceError({ ...sequence(), ...change }));
  }
  for (const change of [
    { sharded: true },
    { extend: true },
    { session: true, scale: true },
  ]) {
    Object.assign(d.sequences[0], sequence(), change);
    assert.throws(() => generateSql(d), /UNSUPPORTED_SEQUENCE_FEATURE/);
  }
});

test('selected prerequisites resolve by type, platform dependencies are recorded and external/remote access remains explicit', () => {
  const d = target();
  const edge = {
    reference: reference('S'),
    type: 'SEQUENCE',
    databaseLink: null,
    oracleMaintained: false,
  };
  d.programs[0].units[0].dependencies = [
    edge,
    {
      ...edge,
      reference: reference('STANDARD', 'SYS'),
      type: 'PACKAGE',
      oracleMaintained: true,
    },
  ];
  assert.doesNotThrow(() => generateSql(d));
  edge.type = 'FUNCTION';
  assert.throws(() => generateSql(d), /INVALID_PROGRAM_UNITS/);
  edge.type = 'SEQUENCE';
  edge.reference = reference('EXTERNAL');
  assert.throws(() => generateSql(d), /UNACKNOWLEDGED_PREREQUISITE/);
  Object.assign(edge, { databaseLink: 'REMOTE' });
  assert.throws(() => generateSql(d), /REMOTE_PREREQUISITE/);
});

test('program cycles compile as groups; mixed creation cycles fail and catalog order does not change SQL', () => {
  const d = target();
  const g = program('G');
  d.programs.push(g);
  d.targetFunctions.push(g.reference);
  const edge = (name: string) => ({
    reference: reference(name),
    type: 'FUNCTION',
    databaseLink: null,
    oracleMaintained: false,
  });
  d.programs[0].units[0].dependencies = [edge('G')];
  g.units[0].dependencies = [edge('F')];
  const sql = generateSql(d);
  assert.ok(
    sql.indexOf('"G" RETURN') <
      sql.indexOf('DECLARE\n  n NUMBER;\n  valid_count'),
  );
  d.programs.reverse();
  d.targetFunctions.reverse();
  assert.equal(generateSql(d), sql);
  const table = ordinaryTable('APP', 'T');
  d.tables.push(table);
  d.targetTables.push(table.reference);
  d.programs[0].units[0].dependencies.push({ ...edge('T'), type: 'TABLE' });
  d.prerequisites.push({
    reference: reference('G'),
    type: 'FUNCTION',
    databaseLink: null,
    requiredBy: table.reference,
  });
  assert.throws(() => generateSql(d), /UNSUPPORTED_CREATION_CYCLE/);
});

test('sequence defaults, program indexes and views order their included dependencies and direct grants', () => {
  const d = target(),
    table = ordinaryTable('OTHER', 'T'),
    view = ordinaryView('V');
  table.columns[0].defaultExpression = 'APP.S.NEXTVAL';
  table.indexes.push({
    ...table.indexes[0],
    reference: reference('IX', 'OTHER'),
    type: 'FUNCTION-BASED NORMAL',
    unique: false,
    keys: [{ column: null, expression: 'APP.F()', direction: 'ASC' }],
    dependencies: [
      { reference: reference('F'), type: 'FUNCTION', databaseLink: null },
    ],
  });
  d.tables = [table];
  d.targetTables = [table.reference];
  d.prerequisites = [
    {
      reference: reference('S'),
      type: 'SEQUENCE',
      databaseLink: null,
      requiredBy: table.reference,
    },
  ];
  view.dependencies = [
    { reference: reference('F'), type: 'FUNCTION', databaseLink: null },
  ];
  d.views = [view];
  d.targetViews = [view.reference];
  const sql = generateSql(d);
  assert.ok(
    sql.indexOf('GRANT SELECT ON "APP"."S"') < sql.indexOf('CREATE TABLE'),
  );
  assert.ok(
    sql.indexOf('CREATE OR REPLACE FUNCTION') < sql.indexOf('CREATE INDEX'),
  );
  assert.match(sql, /GRANT EXECUTE ON "APP"\."F" TO "REPORTING"/);
  assert.match(sql, /GRANT EXECUTE ON "APP"\."F" TO "OTHER"/);
});

test('index-only prerequisites do not create false table/program cycles', () => {
  const d = target(),
    table = ordinaryTable('APP', 'T');
  table.indexes.push({
    ...table.indexes[0],
    reference: reference('F_IX'),
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    keys: [{ expression: 'APP.F()', column: null, direction: 'ASC' }],
    dependencies: [
      { reference: reference('F'), type: 'FUNCTION', databaseLink: null },
    ],
  });
  d.tables = [table];
  d.targetTables = [table.reference];
  d.programs[0].units[0].dependencies = [
    {
      reference: table.reference,
      type: 'TABLE',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  d.prerequisites = [
    {
      requiredBy: table.reference,
      reference: reference('F'),
      type: 'FUNCTION',
      databaseLink: null,
      origin: 'INDEX',
    },
  ];
  const sql = generateSql(d);
  assert.ok(
    sql.indexOf('CREATE TABLE') < sql.indexOf('CREATE OR REPLACE FUNCTION'),
  );
  d.prerequisites[0].origin = 'TABLE';
  assert.throws(() => generateSql(d), /UNSUPPORTED_CREATION_CYCLE/);
});

test('DDL line boundary counts UTF-8 bytes without rewriting lines', () => {
  const d = target();
  d.programs[0].units[0].ddl = 'é'.repeat(1200);
  assert.ok(generateSql(d).includes(d.programs[0].units[0].ddl));
  d.programs[0].units[0].ddl += 'x';
  assert.throws(() => generateSql(d), /SQL_LINE_LIMIT/);
});

test('each new kind can be extracted and generates a dictionary without table/view sheets containing rows', async () => {
  for (const kind of [
    'packages',
    'procedures',
    'functions',
    'sequences',
  ] as const) {
    const name = kind === 'sequences' ? 'S' : 'F';
    const catalog: SourceCatalog = {
      databaseVersion: async () => '23',
      foreignKeys: async () => [],
      table: async () => {
        throw new Error('Unexpected table');
      },
      prerequisites: async () => [],
      sequence: async () => sequence(),
      program: async (_, requestedKind) => ({
        ...program(),
        kind: requestedKind,
        units: [
          {
            ...program().units[0],
            type: requestedKind === 'PACKAGE' ? 'PACKAGE_SPEC' : requestedKind,
          },
        ],
      }),
    };
    const extracted = await extractSource(catalog, {
      version: 2,
      [kind]: [reference(name)],
    });
    assert.equal(extracted.tables.length + extracted.views.length, 0);
    assert.doesNotThrow(() =>
      generateSql(transformSource(extracted, policySchema.parse({}))),
    );
    assert.doesNotThrow(() => buildDictionaryWorkbook(extracted));
  }
});

test('a package specification can precede a view consumed by its body', () => {
  const d = target();
  d.targetFunctions = [];
  d.targetPackages = [reference('F')];
  d.programs[0].kind = 'PACKAGE';
  d.programs[0].units = [
    {
      ...program().units[0],
      type: 'PACKAGE_SPEC',
      ddl: 'CREATE PACKAGE APP.F AS FUNCTION ONE RETURN NUMBER; END;\n/',
    },
    {
      ...program().units[0],
      type: 'PACKAGE_BODY',
      ddl: 'CREATE PACKAGE BODY APP.F AS FUNCTION ONE RETURN NUMBER AS BEGIN RETURN 1; END; END;\n/',
      dependencies: [
        {
          reference: reference('V', 'REPORTING'),
          type: 'VIEW',
          databaseLink: null,
          oracleMaintained: false,
        },
      ],
    },
  ];
  const view = ordinaryView('V');
  view.dependencies = [
    { reference: reference('F'), type: 'PACKAGE', databaseLink: null },
  ];
  d.views = [view];
  d.targetViews = [view.reference];
  d.policy = policySchema.parse({
    createSchemas: false,
    externalPrerequisites: [{ reference: view.reference, type: 'VIEW' }],
  });
  const sql = generateSql(d);
  assert.ok(sql.indexOf('CREATE PACKAGE APP.F') < sql.indexOf('CREATE VIEW'));
  assert.ok(
    sql.indexOf('CREATE VIEW') < sql.indexOf('CREATE PACKAGE BODY APP.F'),
  );
});

test('cyclic cache accepts the exact Oracle boundary for unit and nonunit increments', () => {
  for (const [incrementBy, cacheSize] of [
    ['1', '9'],
    ['3', '3'],
    ['4', '3'],
  ]) {
    const s = {
      ...sequence(),
      minValue: '1',
      maxValue: '10',
      incrementBy,
      cacheSize,
      cycle: true,
    };
    assert.equal(sequenceError(s), undefined);
    assert.ok(
      sequenceError({ ...s, cacheSize: String(Number(cacheSize) + 1) }),
    );
  }
});

test('an increment may equal the Oracle range but cannot exceed it', () => {
  assert.equal(
    sequenceError({ ...sequence(), minValue: '1', maxValue: '2' }),
    undefined,
  );
  assert.equal(
    sequenceError({
      ...sequence(),
      minValue: '1',
      maxValue: '10',
      incrementBy: '9',
    }),
    undefined,
  );
  assert.ok(
    sequenceError({
      ...sequence(),
      minValue: '1',
      maxValue: '10',
      incrementBy: '10',
    }),
  );
});

test('cross-owner table expressions receive direct EXECUTE before table creation', () => {
  const d = target(),
    table = ordinaryTable('OTHER', 'T');
  table.columns[1].virtual = true;
  table.columns[1].defaultExpression = 'APP.F()';
  d.tables = [table];
  d.targetTables = [table.reference];
  d.prerequisites = [
    {
      reference: reference('F'),
      type: 'FUNCTION',
      databaseLink: null,
      requiredBy: table.reference,
      origin: 'TABLE',
    },
  ];
  const sql = generateSql(d);
  assert.ok(
    sql.indexOf('CREATE OR REPLACE FUNCTION') <
      sql.indexOf('GRANT EXECUTE ON "APP"."F" TO "OTHER"'),
  );
  assert.ok(
    sql.indexOf('GRANT EXECUTE ON "APP"."F" TO "OTHER"') <
      sql.indexOf('CREATE TABLE'),
  );
});
