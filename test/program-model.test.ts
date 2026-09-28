import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionSchema,
  policySchema,
  sourceDocumentSchema,
} from '../src/model.js';
import { sourceFixture } from './fixtures.js';

test('selection v2 retains its shape and rejects program fields', () => {
  const reference = { owner: 'APP', name: 'T' };
  assert.deepEqual(selectionSchema.parse({ version: 2, tables: [reference] }), {
    version: 2,
    tables: [reference],
    views: [],
  });
  assert.throws(() =>
    selectionSchema.parse({ version: 2, tables: [reference], procedures: [] }),
  );
});
test('selection v3 supports exact member identities and program-only roots', () => {
  const procedure = {
    owner: 'App.Owner',
    package: 'Some.Package',
    name: 'Do.Work',
  };
  assert.deepEqual(
    selectionSchema.parse({ version: 3, procedures: [procedure] }),
    {
      version: 3,
      tables: [],
      views: [],
      procedures: [procedure],
      packages: [],
    },
  );
  assert.throws(() => selectionSchema.parse({ version: 3 }));
  assert.throws(() =>
    selectionSchema.parse({
      version: 4,
      packages: [{ owner: 'APP', name: 'P' }],
    }),
  );
  assert.throws(() =>
    selectionSchema.parse({
      version: 3,
      procedures: [{ ...procedure, packge: 'TYPO' }],
    }),
  );
});
test('policy v2 allows bounded explicit object privileges while v1 rejects new fields', () => {
  const grant = {
    reference: { owner: 'APP', name: 'T' },
    grantee: 'CALLER',
    privileges: ['SELECT', 'UPDATE'],
  };
  assert.equal(
    policySchema.parse({ version: 2, plsqlObjectGrants: [grant] }).version,
    2,
  );
  assert.throws(() =>
    policySchema.parse({ version: 1, plsqlObjectGrants: [] }),
  );
  for (const privileges of [
    [],
    ['EXECUTE'],
    ['SELECT', 'SELECT'],
    ['ALL'],
    ['SELECT WITH GRANT OPTION'],
  ]) {
    assert.throws(() =>
      policySchema.parse({
        version: 2,
        plsqlObjectGrants: [{ ...grant, privileges }],
      }),
    );
  }
});
test('format 6 requires captured program fields even for legacy selections', () => {
  const source = sourceFixture();
  assert.equal(sourceDocumentSchema.parse(source).formatVersion, 6);
  assert.throws(
    () => sourceDocumentSchema.parse({ ...source, formatVersion: 5 }),
    /re-extract/u,
  );
  const { programs: _, ...missing } = source;
  assert.throws(() => sourceDocumentSchema.parse(missing));
});
