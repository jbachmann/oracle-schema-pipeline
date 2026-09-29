import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFixture, ordinaryTable, ordinaryView } from './fixtures.js';
import {
  selectionSchema,
  sourceDocumentSchema,
  policySchema,
  type SynonymDefinition,
} from '../src/model.js';
import { extractSource, type SourceCatalog } from '../src/extract.js';
import { transformSource } from '../src/transform.js';
import { validateTarget } from '../src/validate.js';
import { generateSql } from '../src/generate.js';
import { schemaOwners } from '../src/schema-owners.js';
import {
  verificationChecks,
  setupRequirements,
  generatedReplay,
} from '../scripts/compose-destination.js';
const ref = (name: string, owner = 'APP') => ({ owner, name });
const alias = (name = 'ALIAS', owner = 'APP'): SynonymDefinition => ({
  reference: ref(name, owner),
  target: ref('T'),
  databaseLink: null,
  editionable: owner !== 'PUBLIC',
  resolution: [{ reference: ref('T'), type: 'TABLE', target: null }],
  unsupportedFeatures: [],
});
function source() {
  const table = ordinaryTable('APP', 'T');
  table.reference = ref('T');
  return {
    ...sourceFixture(),
    targetTables: [table.reference],
    tables: [table],
    targetSynonyms: [ref('ALIAS')],
    synonyms: [alias()],
  };
}
const target = () => transformSource(source(), policySchema.parse({}));
const errors = (document: ReturnType<typeof target>) =>
  validateTarget(document).filter((d) => d.severity === 'error');

test('synonym selection is optional, supports synonym-only and shares the private namespace', () => {
  assert.deepEqual(
    selectionSchema.parse({ version: 2, tables: [ref('T')] }).synonyms,
    [],
  );
  assert.equal(
    selectionSchema.parse({ version: 2, synonyms: [ref('A')] }).synonyms.length,
    1,
  );
  assert.throws(
    () =>
      selectionSchema.parse({
        version: 2,
        synonyms: [ref('A')],
        tables: [ref('A')],
      }),
    /OBJECT_NAME_COLLISION/,
  );
  assert.doesNotThrow(() =>
    selectionSchema.parse({
      version: 2,
      synonyms: [ref('A'), ref('A', 'PUBLIC')],
      tables: [ref('A', 'OTHER')],
    }),
  );
  assert.throws(
    () => sourceDocumentSchema.parse({ ...source(), formatVersion: 6 }),
    /re-extract/,
  );
  assert.throws(
    () => sourceDocumentSchema.parse({ ...source(), synonyms: undefined }),
    /Required/,
  );
});

test('synonym-only extraction deduplicates and never exports targets', async () => {
  const calls: string[] = [];
  const catalog: SourceCatalog = {
    async synonym(reference) {
      calls.push(reference.name);
      return alias(reference.name);
    },
    async databaseVersion() {
      return '23';
    },
    async foreignKeys() {
      throw new Error('Unselected target read');
    },
    async table() {
      throw new Error('Unselected target read');
    },
    async prerequisites() {
      throw new Error('Unselected target read');
    },
  };
  const document = await extractSource(catalog, {
    version: 2,
    synonyms: [ref('A'), ref('A')],
  });
  assert.deepEqual(calls, ['A']);
  assert.deepEqual(document.tables, []);
  assert.equal(document.synonyms.length, 1);
  const unresolved = transformSource(document, policySchema.parse({}));
  assert.ok(
    errors(unresolved).some((d) => d.code === 'UNACKNOWLEDGED_PREREQUISITE'),
  );
  unresolved.policy = policySchema.parse({
    createSchemas: false,
    externalPrerequisites: [{ reference: ref('T'), type: 'TABLE' }],
  });
  assert.deepEqual(errors(unresolved), []);
});

test('aliases precede tables, preserve quoting, never replace and never provision PUBLIC', () => {
  const d = target();
  d.synonyms.push(alias('Odd "é', 'PUBLIC'), alias('PRIVATE', 'ALIAS_OWNER'));
  d.targetSynonyms = d.synonyms.map((s) => s.reference);
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.ok(sql.indexOf('SYNONYM "APP"."ALIAS"') < sql.indexOf('CREATE TABLE'));
  assert.match(
    sql,
    /CREATE NONEDITIONABLE PUBLIC SYNONYM "Odd ""é" FOR "APP"\."T"/,
  );
  assert.doesNotMatch(sql, /CREATE OR REPLACE.*SYNONYM|CREATE USER "PUBLIC"/);
  assert.deepEqual(schemaOwners(d), ['ALIAS_OWNER', 'APP']);
  assert.match(sql, /OSP_SYNONYM_INVALID/);
  assert.match(verificationChecks(d), /dba_synonyms/);
  assert.doesNotThrow(() => generatedReplay(sql));
  assert.equal(
    sql,
    generateSql({
      ...d,
      synonyms: [...d.synonyms].reverse(),
      targetSynonyms: [...d.targetSynonyms].reverse(),
    }),
  );
});

test('chains require every intermediate alias and validate captured mappings', () => {
  const d = target();
  d.synonyms[0].target = ref('B');
  d.synonyms[0].resolution.unshift({
    reference: ref('B'),
    type: 'SYNONYM',
    target: ref('T'),
  });
  assert.ok(errors(d).some((e) => e.code === 'UNACKNOWLEDGED_PREREQUISITE'));
  d.synonyms.push(alias('B'));
  d.targetSynonyms.push(ref('B'));
  assert.deepEqual(errors(d), []);
  d.synonyms[1].target = ref('WRONG');
  assert.ok(errors(d).some((e) => e.code === 'UNRESOLVED_SYNONYM_TARGET'));
});
for (const [name, change, code] of [
  [
    'remote',
    (s: SynonymDefinition) => {
      s.databaseLink = 'LINK';
    },
    'UNSUPPORTED_SYNONYM',
  ],
  [
    'cycle',
    (s: SynonymDefinition) => {
      s.resolution[0].reference = s.reference;
    },
    'SYNONYM_CYCLE',
  ],
  [
    'mismatch',
    (s: SynonymDefinition) => {
      s.resolution[0].reference = ref('WRONG');
    },
    'UNRESOLVED_SYNONYM_TARGET',
  ],
  [
    'unterminated',
    (s: SynonymDefinition) => {
      s.resolution[0].type = 'SYNONYM';
      s.resolution[0].target = ref('X');
    },
    'UNRESOLVED_SYNONYM_TARGET',
  ],
] as const)
  test(`offline generation rejects ${name} metadata`, () => {
    const d = target();
    change(d.synonyms[0]);
    assert.ok(errors(d).some((e) => e.code === code));
    assert.throws(() => generateSql(d));
  });

test('view aliases resolve grants to base tables and enforce target ordering', () => {
  const d = target();
  const view = ordinaryView('V');
  view.dependencies = [
    { reference: ref('ALIAS'), type: 'SYNONYM', databaseLink: null },
  ];
  view.query = 'SELECT ID FROM APP.ALIAS';
  d.views = [view];
  d.targetViews = [view.reference];
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.match(sql, /GRANT SELECT ON "APP"\."T" TO "REPORTING"/);
  assert.doesNotMatch(sql, /GRANT SELECT ON "APP"\."ALIAS"/);
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('CREATE VIEW'));
});

test('program dependencies through aliases order targets and retain explicit access setup', () => {
  const d = target();
  d.programs = [
    {
      reference: ref('P'),
      kind: 'PROCEDURE',
      unsupportedFeatures: [],
      units: [
        {
          type: 'PROCEDURE',
          ddl: 'CREATE PROCEDURE "APP"."P" AS BEGIN NULL; END;\n/',
          status: 'VALID',
          dependencies: [
            {
              reference: ref('ALIAS'),
              type: 'SYNONYM',
              databaseLink: null,
              oracleMaintained: false,
            },
          ],
        },
      ],
    },
  ];
  d.targetProcedures = [ref('P')];
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('CREATE PROCEDURE'));
  d.programs[0].reference.owner = 'OTHER';
  d.targetProcedures = [ref('P', 'OTHER')];
  assert.ok(
    errors(d).some(
      (e) =>
        e.code === 'UNACKNOWLEDGED_PREREQUISITE' && e.message.includes('TABLE'),
    ),
  );
});

test('alias-only documents require selected definitions and reject extra or colliding aliases', () => {
  const d = target();
  d.targetSynonyms.push(ref('MISSING'));
  assert.ok(errors(d).some((e) => e.code === 'MISSING_TARGET'));
  d.targetSynonyms.pop();
  d.synonyms.push(alias('T'));
  d.targetSynonyms.push(ref('T'));
  assert.ok(errors(d).some((e) => e.code === 'OBJECT_NAME_COLLISION'));
});

test('view-to-view alias ordering works without any selected programs', () => {
  const d = target();
  const base = ordinaryView('Z_BASE'),
    consumer = ordinaryView('A_CONSUMER');
  base.query = 'SELECT ID FROM APP.T';
  base.dependencies = [
    { reference: ref('T'), type: 'TABLE', databaseLink: null },
  ];
  consumer.query = 'SELECT ID FROM APP.ALIAS';
  consumer.dependencies = [
    { reference: ref('ALIAS'), type: 'SYNONYM', databaseLink: null },
  ];
  d.synonyms[0].target = base.reference;
  d.synonyms[0].resolution = [
    { reference: base.reference, type: 'VIEW', target: null },
  ];
  d.views = [consumer, base];
  d.targetViews = d.views.map((v) => v.reference);
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.ok(
    sql.indexOf('CREATE VIEW "REPORTING"."Z_BASE"') <
      sql.indexOf('CREATE VIEW "REPORTING"."A_CONSUMER"'),
  );
});

test('function aliases supply narrow grants for table expressions and deferred indexes', () => {
  const d = target();
  const f = ref('F', 'CODE');
  d.programs = [
    {
      reference: f,
      kind: 'FUNCTION',
      unsupportedFeatures: [],
      units: [
        {
          type: 'FUNCTION',
          status: 'VALID',
          ddl: 'CREATE FUNCTION "CODE"."F"(x NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN x; END;\n/',
          dependencies: [],
        },
      ],
    },
  ];
  d.targetFunctions = [f];
  d.synonyms[0].target = f;
  d.synonyms[0].resolution = [{ reference: f, type: 'FUNCTION', target: null }];
  const edge = { reference: ref('ALIAS'), type: 'SYNONYM', databaseLink: null };
  d.prerequisites = [{ ...edge, requiredBy: ref('T'), origin: 'TABLE' }];
  d.tables[0].columns[1].defaultExpression = 'APP.ALIAS(1)';
  d.tables[0].indexes.push({
    ...d.tables[0].indexes[0],
    reference: ref('F_IDX'),
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    dependencies: [edge],
    keys: [{ column: null, expression: 'APP.ALIAS(ID)', direction: 'ASC' }],
  });
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.match(sql, /GRANT EXECUTE ON "CODE"\."F" TO "APP"/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON "APP"\."ALIAS"/);
  assert.ok(sql.indexOf('CREATE FUNCTION') < sql.indexOf('CREATE TABLE'));
  assert.ok(sql.indexOf('GRANT EXECUTE') < sql.indexOf('CREATE TABLE'));
});

test('synonym resolution cannot hide mixed creation cycles', () => {
  const d = target();
  const f = ref('F');
  d.programs = [
    {
      reference: f,
      kind: 'FUNCTION',
      unsupportedFeatures: [],
      units: [
        {
          type: 'FUNCTION',
          status: 'VALID',
          ddl: 'CREATE FUNCTION APP.F RETURN NUMBER AS BEGIN RETURN 1; END;\n/',
          dependencies: [
            {
              reference: ref('T'),
              type: 'TABLE',
              databaseLink: null,
              oracleMaintained: false,
            },
          ],
        },
      ],
    },
  ];
  d.targetFunctions = [f];
  d.synonyms[0].target = f;
  d.synonyms[0].resolution = [{ reference: f, type: 'FUNCTION', target: null }];
  d.prerequisites = [
    {
      reference: ref('ALIAS'),
      type: 'SYNONYM',
      databaseLink: null,
      requiredBy: ref('T'),
      origin: 'TABLE',
    },
  ];
  assert.ok(errors(d).some((e) => e.code === 'UNSUPPORTED_CREATION_CYCLE'));
});

test('conflicting external chain mappings fail before SQL publication', () => {
  const d = target();
  d.synonyms[0].target = ref('EXTERNAL');
  d.synonyms[0].resolution.unshift({
    reference: ref('EXTERNAL'),
    type: 'SYNONYM',
    target: ref('T'),
  });
  const second = structuredClone(d.synonyms[0]);
  second.reference = ref('SECOND');
  second.resolution[0].target = ref('OTHER_T');
  second.resolution[1].reference = ref('OTHER_T');
  d.synonyms.push(second);
  d.targetSynonyms.push(second.reference);
  assert.ok(
    errors(d).some(
      (e) =>
        e.code === 'UNRESOLVED_SYNONYM_TARGET' &&
        e.message.includes('shared target'),
    ),
  );
});

test('external intermediate aliases are checked by mapping, not transient status', () => {
  const d = target();
  d.synonyms[0].target = ref('EXTERNAL');
  d.synonyms[0].resolution.unshift({
    reference: ref('EXTERNAL'),
    type: 'SYNONYM',
    target: ref('T'),
  });
  d.policy = policySchema.parse({
    createSchemas: false,
    externalPrerequisites: [{ reference: ref('EXTERNAL'), type: 'SYNONYM' }],
  });
  const requirement = setupRequirements(d).find((item) =>
    item.from.startsWith('dba_synonyms'),
  );
  assert.ok(requirement);
  assert.match(
    requirement.from,
    /synonym_name='EXTERNAL'.*table_owner='APP'.*table_name='T'.*db_link IS NULL/,
  );
  assert.doesNotMatch(requirement.from, /status/);
});

test('consumers of captured external hops still wait for included terminals', () => {
  const d = target();
  d.synonyms[0].target = ref('EXTERNAL');
  d.synonyms[0].resolution.unshift({
    reference: ref('EXTERNAL'),
    type: 'SYNONYM',
    target: ref('T'),
  });
  d.policy = policySchema.parse({
    createSchemas: false,
    externalPrerequisites: [{ reference: ref('EXTERNAL'), type: 'SYNONYM' }],
  });
  d.programs = [
    {
      reference: ref('A_PROC'),
      kind: 'PROCEDURE',
      unsupportedFeatures: [],
      units: [
        {
          type: 'PROCEDURE',
          status: 'VALID',
          ddl: 'CREATE PROCEDURE APP.A_PROC AS BEGIN NULL; END;\n/',
          dependencies: [
            {
              reference: ref('EXTERNAL'),
              type: 'SYNONYM',
              databaseLink: null,
              oracleMaintained: false,
            },
          ],
        },
      ],
    },
  ];
  d.targetProcedures = [ref('A_PROC')];
  assert.deepEqual(errors(d), []);
  const sql = generateSql(d);
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('CREATE PROCEDURE'));
});
