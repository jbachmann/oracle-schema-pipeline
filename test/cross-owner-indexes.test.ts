import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFixture } from './fixtures.js';
import {
  policySchema,
  sourceDocumentSchema,
  targetDocumentSchema,
} from '../src/model.js';
import { transformSource } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { validateTarget } from '../src/validate.js';
import { schemaOwners } from '../src/schema-owners.js';
import { indexRequirements } from '../src/index-grants.js';
import {
  setupChecks,
  verificationChecks,
} from '../scripts/compose-destination.js';

function fixture() {
  const source = sourceFixture();
  for (const table of source.tables) {
    const index = table.indexes[0];
    index.reference.owner = 'Index "Owner';
    const key = table.constraints[0];
    if (key.kind === 'primary-key') key.backingIndex = { ...index.reference };
  }
  return source;
}
test('cross-owner backing indexes preserve identities and provision index-only owners exactly once', () => {
  const source = fixture();
  const before = JSON.stringify(source);
  for (const createSchemas of [true, false]) {
    const target = transformSource(
      source,
      policySchema.parse({ createSchemas }),
    );
    assert.deepEqual(validateTarget(target), []);
    assert.deepEqual(schemaOwners(target), ['APP', 'Index "Owner', 'SHARED']);
    const sql = generateSql(target);
    assert.equal(
      (sql.match(/CREATE USER "Index ""Owner"/g) ?? []).length,
      createSchemas ? 1 : 0,
    );
    assert.match(sql, /USING INDEX "Index ""Owner"\."PK_CHILD"/);
    assert.doesNotMatch(sql, /GRANT (?:INDEX|EXECUTE)/);
    assert.match(setupChecks(target), /username='Index "Owner'/);
    assert.match(
      verificationChecks(target),
      /index_owner='Index "Owner' AND index_name='PK_CHILD'/,
    );
    assert.match(
      verificationChecks(target),
      /table_owner='APP' AND table_name='CHILD'/,
    );
    target.tables.reverse();
    assert.equal(generateSql(target), sql);
  }
  assert.equal(JSON.stringify(source), before);
});
function functionFixture() {
  const source = fixture();
  const table = source.tables[0];
  const dependency = {
    reference: { owner: 'Util', name: 'F"n' },
    type: 'FUNCTION',
    databaseLink: null,
  };
  table.indexes.push({
    ...structuredClone(table.indexes[0]),
    reference: { owner: 'Function Owner', name: 'F_IDX' },
    type: 'FUNCTION-BASED NORMAL',
    unique: false,
    keys: [
      { column: null, expression: '"Util"."F""n"("ID")', direction: 'ASC' },
    ],
    dependencies: [dependency, dependency],
  });
  source.prerequisites.push({ ...dependency, requiredBy: table.reference });
  return transformSource(
    source,
    policySchema.parse({
      createSchemas: false,
      externalPrerequisites: [
        { reference: dependency.reference, type: dependency.type },
      ],
    }),
  );
}
test('exact index dependencies produce deduplicated quoted grants before indexes and report changes', () => {
  const target = functionFixture();
  assert.deepEqual(validateTarget(target), []);
  const sql = generateSql(target);
  const grant = 'GRANT EXECUTE ON "Util"."F""n" TO "Function Owner";';
  assert.equal(sql.split(grant).length, 2);
  assert.ok(sql.indexOf(grant) < sql.indexOf('CREATE INDEX'));
  assert.doesNotMatch(sql, /TO "Index ""Owner"|WITH GRANT OPTION|GRANT CREATE/);
  assert.deepEqual(
    target.diagnostics
      .filter((d) => d.code === 'INDEX_REQUIRED_GRANT')
      .map((d) => d.message),
    [grant],
  );
  assert.match(
    verificationChecks(target),
    /grantee='Function Owner' AND privilege='EXECUTE'/,
  );
  target.tables[0].indexes[1].reference.owner = 'Util';
  assert.deepEqual(indexRequirements(target).grants, []);
});
test('missing or unsupported dependency metadata and unacknowledged edges fail closed', () => {
  for (const type of ['SYNONYM', 'TYPE', 'TABLE', 'PROCEDURE']) {
    const target = functionFixture();
    target.tables[0].indexes[1].dependencies[0].type = type;
    assert.ok(
      validateTarget(target).some(
        (d) => d.code === 'UNSUPPORTED_INDEX_DEPENDENCY',
      ),
    );
    assert.throws(() => generateSql(target));
  }
  for (const alter of [
    (target: ReturnType<typeof functionFixture>) => {
      target.prerequisites = [];
    },
    (target: ReturnType<typeof functionFixture>) => {
      target.policy.externalPrerequisites = [];
    },
    (target: ReturnType<typeof functionFixture>) => {
      target.prerequisites[0].requiredBy.owner = 'WRONG';
    },
  ]) {
    const target = functionFixture();
    alter(target);
    assert.ok(
      validateTarget(target).some(
        (d) => d.code === 'UNACKNOWLEDGED_PREREQUISITE',
      ),
    );
    assert.throws(() => generateSql(target));
  }
  const target = functionFixture();
  target.tables[0].indexes[1].dependencies[0].databaseLink = 'REMOTE';
  assert.ok(
    validateTarget(target).some(
      (d) => d.code === 'UNSUPPORTED_INDEX_DEPENDENCY',
    ),
  );
  const missing = structuredClone(target) as any;
  delete missing.tables[0].indexes[0].dependencies;
  assert.throws(() => targetDocumentSchema.parse(missing), /dependencies/);
  assert.throws(
    () => sourceDocumentSchema.parse({ ...sourceFixture(), formatVersion: 4 }),
    /format v5; re-extract/,
  );
});
test('cross-owner support retains independent index and backing-reference rejection', () => {
  const target = transformSource(fixture(), policySchema.parse({}));
  target.tables[1].indexes[0].reference = {
    ...target.tables[0].indexes[0].reference,
  };
  assert.ok(validateTarget(target).some((d) => d.code === 'DUPLICATE_INDEX'));
  assert.ok(
    validateTarget(target).some((d) => d.code === 'MISSING_BACKING_INDEX'),
  );
  target.diagnostics.push({
    severity: 'error',
    code: 'CROSS_OWNER_INDEX',
    object: 'edited',
    message: 'User error',
  });
  assert.throws(() => generateSql(target));
});

test('qualified duplicate names remain distinct and unresolved backing owners do not provision schemas', () => {
  const source = fixture();
  for (const [position, table] of source.tables.entries()) {
    table.indexes[0].reference = {
      owner: position ? 'Index owner' : 'Index Owner',
      name: 'SAME_NAME',
    };
    const key = table.constraints[0];
    if (key.kind === 'primary-key')
      key.backingIndex = { ...table.indexes[0].reference };
  }
  const target = transformSource(source, policySchema.parse({}));
  assert.deepEqual(validateTarget(target), []);
  assert.deepEqual(schemaOwners(target), [
    'APP',
    'Index Owner',
    'Index owner',
    'SHARED',
  ]);
  const key = target.tables[0].constraints[0];
  if (key.kind === 'primary-key') key.backingIndex!.owner = 'Unresolved';
  assert.ok(!schemaOwners(target).includes('Unresolved'));
  assert.ok(
    validateTarget(target).some((d) => d.code === 'MISSING_BACKING_INDEX'),
  );
});

test('required grants sort by exact object and grantee and ignore input ordering', () => {
  const target = functionFixture();
  const table = target.tables[0];
  const original = table.indexes[1];
  for (const owner of ['Z', 'A', 'a', 'A"']) {
    table.indexes.push({
      ...structuredClone(original),
      reference: { owner, name: 'FUNCTION_INDEX' },
    });
  }
  const before = indexRequirements(target).grants;
  assert.deepEqual(
    before.map((grant) => grant.grantee),
    ['A', 'A"', 'Function Owner', 'Z', 'a'],
  );
  const sql = generateSql(target);
  target.tables.reverse();
  for (const item of target.tables) item.indexes.reverse();
  assert.deepEqual(indexRequirements(target).grants, before);
  assert.equal(generateSql(target), sql);
});

test('contradictory direct dependency types cannot authorize a guessed grant', () => {
  const target = functionFixture();
  const index = target.tables[0].indexes[1];
  index.dependencies.push({
    ...structuredClone(index.dependencies[0]),
    type: 'PACKAGE',
  });
  assert.deepEqual(indexRequirements(target).grants, []);
  assert.ok(
    validateTarget(target).some(
      (d) =>
        d.code === 'UNSUPPORTED_INDEX_DEPENDENCY' &&
        /Ambiguous/.test(d.message),
    ),
  );
  assert.throws(() => generateSql(target), /UNSUPPORTED_INDEX_DEPENDENCY/);
});
