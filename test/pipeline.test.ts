import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSource, type SourceCatalog } from '../src/extract.js';
import { transformSource, transformationReport } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { validateTarget } from '../src/validate.js';
import { objectKey, sourceDocumentSchema, targetDocumentSchema, policySchema } from '../src/model.js';
import { renderDataType } from '../src/types.js';
import { sourceFixture, ordinaryTable, fk, numberColumn, enabledState } from './fixtures.js';

const hasError = (target: unknown, code: string) => validateTarget(target).some(item => item.code === code && item.severity === 'error');
test('one-hop extraction captures parent FK facts but never fetches grandparent table', async () => {
  const fixture = sourceFixture(), fetched: string[] = [], rootLookups: string[] = [];
  const catalog: SourceCatalog = {
    async databaseVersion() { return '19'; },
    async foreignKeys(reference) { rootLookups.push(reference.name); return fixture.tables.find(table => objectKey(table.reference) === objectKey(reference))!.constraints.filter(constraint => constraint.kind === 'foreign-key'); },
    async table(reference) { fetched.push(reference.name); return structuredClone(fixture.tables.find(table => objectKey(table.reference) === objectKey(reference))!); },
    async prerequisites() { return []; },
  };
  const source = await extractSource(catalog, fixture.targetTables);
  assert.deepEqual(rootLookups, ['CHILD']); assert.deepEqual(fetched, ['CHILD', 'PARENT']);
  assert.ok(source.tables[1].constraints.some(constraint => constraint.name === 'FK_PARENT_GRANDPARENT'));
});
test('transformation removes only parent-origin FKs and does not mutate source', () => {
  const source = sourceFixture(), before = JSON.stringify(source), target = transformSource(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(target.tables.flatMap(table => table.constraints.filter(constraint => constraint.kind === 'foreign-key').map(constraint => constraint.name)), ['FK_CHILD_PARENT']);
  assert.ok(transformationReport(target).some(item => item.code === 'OMIT_PARENT_FK'));
  assert.equal(validateTarget(target).filter(item => item.severity === 'error').length, 0);
});
test('explicit second target retains its FK and requires its direct parent definition', () => {
  const source = sourceFixture(); source.targetTables.push(source.tables[1].reference);
  const grandparent = ordinaryTable('OTHER', 'GRANDPARENT'); grandparent.role = 'direct-parent'; source.tables.push(grandparent);
  const target = transformSource(source);
  assert.equal(validateTarget(target).length, 0);
  assert.ok(generateSql(target).includes('FK_PARENT_GRANDPARENT'));
});
test('generation orders all tables, indexes, candidate keys and FKs; composite order preserved', () => {
  const sql = generateSql(transformSource(sourceFixture()));
  assert.ok(sql.lastIndexOf('CREATE TABLE') < sql.indexOf('CREATE UNIQUE INDEX'));
  assert.ok(sql.lastIndexOf('CREATE UNIQUE INDEX') < sql.indexOf('ADD CONSTRAINT "PK_'));
  assert.ok(sql.lastIndexOf('PRIMARY KEY') < sql.indexOf('FOREIGN KEY'));
  assert.ok(sql.includes('FOREIGN KEY ("TENANT_ID", "ID") REFERENCES "SHARED"."PARENT" ("TENANT_ID", "ID")'));
  assert.equal((sql.match(/CREATE UNIQUE INDEX "SHARED"\."PK_PARENT"/g) ?? []).length, 1);
  assert.ok(sql.includes('USING INDEX "SHARED"."PK_PARENT"'));
  assert.ok(sql.includes('GRANT REFERENCES ON "SHARED"."PARENT" TO "APP";'));
  assert.ok(!sql.includes('GRANDPARENT')); assert.ok(!sql.includes('PROD_DATA')); assert.ok(!sql.includes('STORAGE ('));
});
test('runtime validation rejects unknown fields and format versions', () => {
  assert.throws(() => sourceDocumentSchema.parse({ ...sourceFixture(), formatVersion: 999 }));
  assert.throws(() => sourceDocumentSchema.parse({ ...sourceFixture(), typo: true }));
  assert.throws(() => targetDocumentSchema.parse(sourceFixture()));
});
test('missing parent or mismatched ordered parent key blocks SQL', () => {
  const target = transformSource(sourceFixture()); target.tables.pop();
  assert.ok(hasError(target, 'MISSING_PARENT')); assert.throws(() => generateSql(target), /MISSING_PARENT/);
  const mismatch = transformSource(sourceFixture());
  const foreignKey = mismatch.tables[0].constraints.find(constraint => constraint.kind === 'foreign-key')!;
  if (foreignKey.kind === 'foreign-key') foreignKey.columnPairs.reverse();
  assert.ok(hasError(mismatch, 'MISSING_PARENT_KEY'));
});
test('parent-only FKs cannot be restored manually without validation failure', () => {
  const target = transformSource(sourceFixture()); target.tables[1].constraints.push(fk('FK_BACK', target.tables[0].reference));
  assert.ok(hasError(target, 'PARENT_FK_RETAINED'));
});
test('missing backing indexes and duplicate schema constraint names are rejected', () => {
  const target = transformSource(sourceFixture()); target.tables[0].indexes = [];
  assert.ok(hasError(target, 'MISSING_BACKING_INDEX'));
  target.tables[0].constraints.push(structuredClone(target.tables[0].constraints[0]));
  assert.ok(hasError(target, 'DUPLICATE_CONSTRAINT'));
});
test('deferrable FK, delete action, disabled and validation state survive generation', () => {
  const target = transformSource(sourceFixture());
  const constraint = target.tables[0].constraints.find(constraint => constraint.kind === 'foreign-key')!;
  if (constraint.kind === 'foreign-key') {
    constraint.onDelete = 'SET NULL'; constraint.state = { enabled: false, validated: false, deferrable: true, initiallyDeferred: true, rely: true };
  }
  assert.ok(generateSql(target).includes('ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED RELY DISABLE NOVALIDATE'));
});
test('defaults and named not-null constraints are emitted once, including DEFAULT ON NULL', () => {
  const target = transformSource(sourceFixture()), table = target.tables[0], column = numberColumn('VALUE', 3);
  column.defaultExpression = '42'; column.defaultOnNull = true; table.columns.push(column);
  table.constraints.push({ kind: 'not-null', name: 'NN_VALUE', column: 'VALUE', generatedName: false, state: { ...enabledState } });
  const sql = generateSql(target);
  assert.equal((sql.match(/CONSTRAINT "NN_VALUE"/g) ?? []).length, 1);
  assert.ok(sql.includes('DEFAULT ON NULL 42 CONSTRAINT "NN_VALUE" NOT NULL'));
});
test('NUMBER negative scale and CHAR/BYTE semantics are preserved', () => {
  const policy = policySchema.parse({}), column = numberColumn('X', 1);
  column.dataType.precision = null; column.dataType.scale = -2;
  assert.equal(renderDataType(column, policy), 'NUMBER(*,-2)');
  column.dataType = { name: 'VARCHAR2', owner: null, byteLength: 400, characterLength: 100, lengthSemantics: 'CHAR', precision: null, scale: null };
  assert.equal(renderDataType(column, policy), 'VARCHAR2(100 CHAR)');
  column.dataType.lengthSemantics = 'BYTE'; assert.equal(renderDataType(column, policy), 'VARCHAR2(400 BYTE)');
});
test('unsupported identity, specialized tables and internal index expressions block generation', () => {
  const target = transformSource(sourceFixture());
  target.tables[0].columns[0].identity = { generation: 'ALWAYS', options: 'START WITH: 1' };
  target.tables[0].unsupportedFeatures.push('Partitioned table');
  target.tables[0].indexes[0].keys[0] = { column: null, expression: 'SYS_OP_DESCEND("TENANT_ID")', direction: 'DESC' };
  assert.ok(hasError(target, 'UNSUPPORTED_IDENTITY')); assert.ok(hasError(target, 'UNSUPPORTED_FEATURE'));
  assert.ok(hasError(target, 'INTERNAL_INDEX_EXPRESSION')); assert.throws(() => generateSql(target));
});
test('external prerequisites must be acknowledged and schemas preprovisioned', () => {
  const source = sourceFixture(); source.prerequisites.push({ requiredBy: source.tables[0].reference,
    reference: { owner: 'APP', name: 'NEXT_VALUE' }, type: 'SEQUENCE', databaseLink: null });
  assert.ok(hasError(transformSource(source), 'UNACKNOWLEDGED_PREREQUISITE'));
  const target = transformSource(source, { createSchemas: false, externalPrerequisites: [{ reference: { owner: 'APP', name: 'NEXT_VALUE' }, type: 'SEQUENCE' }] });
  assert.equal(validateTarget(target).length, 0); assert.ok(!generateSql(target).includes('CREATE USER'));
});
test('quoted identifiers and SQL fragments remain intact', () => {
  const source = sourceFixture(); const column = numberColumn('Odd"Name', 3); column.nullable = true;
  column.defaultExpression = "CASE WHEN 1=1 THEN 7 ELSE 9 END"; source.tables[0].columns.push(column);
  source.tables[0].constraints.push({ kind: 'check', name: 'CK_ODD', expression: '"Odd""Name" >= 0', generatedName: false, state: { ...enabledState } });
  const sql = generateSql(transformSource(source));
  assert.ok(sql.includes('"Odd""Name" NUMBER')); assert.ok(sql.includes(column.defaultExpression)); assert.ok(sql.includes('CHECK ("Odd""Name" >= 0)'));
});
test('function indexes and virtual columns keep their expressions', () => {
  const target = transformSource(sourceFixture()), table = target.tables[0];
  const virtual = numberColumn('DOUBLE_ID', 3); virtual.virtual = true; virtual.nullable = true; virtual.defaultExpression = '"ID" * 2'; table.columns.push(virtual);
  table.indexes.push({ ...structuredClone(table.indexes[0]), reference: { owner: 'APP', name: 'IX_EXPRESSION' }, unique: false, type: 'FUNCTION-BASED NORMAL', keys: [{ column: null, expression: 'ABS("ID")', direction: 'ASC' }] });
  const sql = generateSql(target); assert.ok(sql.includes('GENERATED ALWAYS AS ("ID" * 2) VIRTUAL')); assert.ok(sql.includes('(ABS("ID") ASC)'));
});
test('deterministic offline output and repeated JSON round trips', () => {
  const target = transformSource(JSON.parse(JSON.stringify(sourceFixture())));
  assert.equal(generateSql(target), generateSql(JSON.parse(JSON.stringify(target))));
});

test('identity options preserve large numeric bounds and never emit the source sequence default', () => {
  const target = transformSource(sourceFixture()), column = target.tables[0].columns[1];
  column.identity = { generation: 'BY DEFAULT', options: 'START WITH: 1, INCREMENT BY: 1, MAX_VALUE: 9999999999999999999999999999, MIN_VALUE: 1, CYCLE_FLAG: N, CACHE_SIZE: 20, ORDER_FLAG: N' };
  column.defaultOnNull = true; column.defaultExpression = '"APP"."ISEQ$$_123".nextval';
  const sql = generateSql(target);
  assert.ok(sql.includes('GENERATED BY DEFAULT ON NULL AS IDENTITY'));
  assert.ok(sql.includes('MAXVALUE 9999999999999999999999999999'));
  assert.ok(!sql.includes('ISEQ$$_123'));
});
test('dollar replacement patterns in quoted index names remain literal', () => {
  const target = transformSource(sourceFixture()), table = target.tables[0];
  table.indexes[0].reference.name = 'IX$&$1';
  const key = table.constraints.find(constraint => constraint.kind === 'primary-key')!;
  if (key.kind === 'primary-key') key.backingIndex = { ...table.indexes[0].reference };
  assert.ok(generateSql(target).includes('USING INDEX "APP"."IX$&$1" ENABLE VALIDATE'));
});
