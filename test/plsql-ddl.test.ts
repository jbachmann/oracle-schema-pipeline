import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProgramDdl, renderProgramAssertion } from '../src/plsql-ddl.js';

const reference = { owner: 'APP', name: 'P' };
test('large program DDL uses CLOB PARSE with bounded physical lines and no execute', () => {
  const source = `PACKAGE BODY p AS\n/* ${'x'.repeat(40000)}\n/\n&name\nHOST danger\n*/\nEND;`;
  const sql = renderProgramDdl({
    reference,
    type: 'PACKAGE BODY',
    source,
    editionable: true,
    operationIndex: 3,
  });
  assert.match(sql, /DBMS_SQL\.PARSE\(c, d, DBMS_SQL.NATIVE\)/u);
  assert.doesNotMatch(sql, /DBMS_SQL\.EXECUTE|CREATE OR REPLACE/u);
  assert.ok(sql.split('\n').every((line) => Buffer.byteLength(line) <= 2400));
  assert.equal(sql.split('\n').filter((line) => line === '/').length, 2);
  assert.doesNotMatch(sql, /^HOST danger/mu);
  assert.match(sql, /PLSQL_COMPILE_FAILED:3/u);
  assert.match(
    sql,
    /WHEN OTHERS THEN[\s\S]*CLOSE_CURSOR[\s\S]*FREETEMPORARY[\s\S]*RAISE;/u,
  );
});
test('assertions check exact unit validity and errors but never invoke it', () => {
  const sql = renderProgramAssertion(
    { owner: "O'W", name: 'P' },
    'PACKAGE BODY',
    0,
  );
  assert.match(sql, /OWNER='O''W'/u);
  assert.match(sql, /OBJECT_TYPE='PACKAGE BODY' AND STATUS='VALID'/u);
  assert.match(sql, /ATTRIBUTE='ERROR'/u);
  assert.throws(() => renderProgramAssertion(reference, 'PROCEDURE', -1));
});
