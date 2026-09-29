import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programTarget, program } from './program-fixtures.js';
import { objectGrants } from '../src/object-grants.js';
import { generateSql } from '../src/generate.js';

test('explicit grants reject unrelated owners, wrong types, synonyms, self grants and unsupported privileges', () => {
  const target = programTarget();
  const consumer = program('Q');
  consumer.reference.owner = 'OTHER';
  target.programUnits.push(consumer);
  target.targetProcedures.push(consumer.reference);
  const base = {
    reference: target.programUnits[0].reference,
    type: 'PROCEDURE' as const,
    grantee: 'OTHER',
    privileges: ['EXECUTE' as const],
  };
  target.policy.objectGrants = [base, base];
  assert.equal(objectGrants(target).grants.length, 1);
  for (const change of [
    { grantee: 'UNRELATED' },
    { grantee: 'PUBLIC' },
    { grantee: 'APP' },
    { type: 'TABLE' as const },
    { privileges: ['SELECT' as const] },
  ]) {
    target.policy.objectGrants = [{ ...base, ...change }];
    assert.throws(() => generateSql(target), /INVALID_OBJECT_GRANT/);
  }
});

test('grant to a selected provider needs no external acknowledgment and precedes dependent compilation', () => {
  const target = programTarget(),
    consumer = program('Q');
  consumer.reference.owner = 'OTHER';
  consumer.dependencies = [
    {
      reference: target.programUnits[0].reference,
      type: 'PROCEDURE',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  target.programUnits.push(consumer);
  target.targetProcedures.push(consumer.reference);
  target.policy.objectGrants = [
    {
      reference: target.programUnits[0].reference,
      type: 'PROCEDURE',
      grantee: 'OTHER',
      privileges: ['EXECUTE'],
    },
  ];
  const sql = generateSql(target);
  assert.ok(
    sql.indexOf('-- Compile PROCEDURE "APP"."P"') <
      sql.indexOf('GRANT EXECUTE'),
  );
  assert.ok(
    sql.indexOf('GRANT EXECUTE') <
      sql.indexOf('-- Compile PROCEDURE "OTHER"."Q"'),
  );
});
