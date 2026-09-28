import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectPlsqlSource,
  lexPlsql,
  PlsqlSourceError,
  qualifyPlsqlSource,
} from '../src/plsql.js';

const reference = { owner: 'App.Owner', name: 'Do "Work' };
const header = 'PROCEDURE "Do ""Work"';
const body = `(p varchar2) AUTHID CURRENT_USER AS\r\nBEGIN\n  NULL;\nEND;\n`;

test('qualifies only the declaration identifier and preserves every other source byte', () => {
  const prefix = '-- PROCEDURE decoy\r\n/* π */ ';
  const source = prefix + header + body;
  assert.equal(
    qualifyPlsqlSource(source, reference, 'PROCEDURE'),
    prefix + 'PROCEDURE "App.Owner"."Do ""Work"' + body,
  );
  const qualified = prefix + 'PROCEDURE "App.Owner"."Do ""Work"' + body;
  assert.equal(
    qualifyPlsqlSource(qualified, reference, 'PROCEDURE'),
    qualified,
  );
});

test('ignores directives, external declarations and headers in all literal forms and comments', () => {
  for (const literal of [
    "'it''s $if wrapped'",
    "N'$$flag'",
    "q'[LANGUAGE JAVA $end]'",
    "nq'!external PROCEDURE fake!'",
    "q'<$error>'",
  ]) {
    const source = `procedure p as x varchar2(200) := ${literal}; /* wrapped */\nbegin null; end;`;
    assert.doesNotThrow(() =>
      inspectPlsqlSource(source, { owner: 'APP', name: 'P' }, 'PROCEDURE'),
    );
  }
  assert.equal(lexPlsql('"$if" "WRAPPED"').length, 2);
});

test('rejects conditional directives and inquiry tokens without exposing source', () => {
  for (const directive of [
    '$if',
    '$then',
    '$else',
    '$elsif',
    '$end',
    '$error',
    '$$PLSQL_UNIT',
  ]) {
    assert.throws(
      () => lexPlsql(`begin ${directive} secret_literal; end;`),
      (error: unknown) => {
        assert.ok(error instanceof PlsqlSourceError);
        assert.equal(error.code, 'UNSUPPORTED_PLSQL_CONDITIONAL');
        assert.equal(error.message.includes('secret_literal'), false);
        return true;
      },
    );
  }
});

test('rejects malformed envelopes, wrong identities, and SQL client terminators', () => {
  for (const source of [
    'procedure other as begin null; end;',
    'create procedure p as begin null; end;',
    'procedure wrong.p as begin null; end;',
    'procedure p as begin null; end;\n/',
    'procedure p',
    "procedure p as x varchar2(20) := 'unterminated;",
    '/* unterminated',
  ]) {
    assert.throws(
      () =>
        inspectPlsqlSource(source, { owner: 'APP', name: 'P' }, 'PROCEDURE'),
      PlsqlSourceError,
    );
  }
});

test('rejects wrapped and external-language sources', () => {
  for (const source of [
    'procedure p wrapped abc',
    'procedure p as external;',
    "procedure p as language java name 'secret';",
  ]) {
    assert.throws(
      () =>
        inspectPlsqlSource(source, { owner: 'APP', name: 'P' }, 'PROCEDURE'),
      (error: unknown) =>
        error instanceof PlsqlSourceError && error.code === 'UNSUPPORTED_PLSQL',
    );
  }
});

test('supports package specifications, bodies, functions and large literal lines', () => {
  for (const type of ['PACKAGE', 'PACKAGE BODY', 'FUNCTION'] as const) {
    const source = `${type} p AS /* ${'π'.repeat(40000)} */ begin null; end;`;
    assert.equal(
      qualifyPlsqlSource(source, { owner: 'APP', name: 'P' }, type),
      source.replace(' p AS', ' "APP"."P" AS'),
    );
  }
});

test('package body evidence distinguishes declarations from REF CURSOR types and defined cursors', async () => {
  const { packageDeclarationEvidence, declarationAuthid } =
    await import('../src/plsql.js');
  const reference = { owner: 'APP', name: 'P' };
  for (const source of [
    'PACKAGE p AS TYPE c IS REF CURSOR; END;',
    'PACKAGE p AS CURSOR c IS SELECT 1 FROM dual; END;',
  ])
    assert.equal(
      packageDeclarationEvidence(source, reference).bodyRequired,
      false,
    );
  assert.equal(
    packageDeclarationEvidence(
      'PACKAGE p AS CURSOR c RETURN t%ROWTYPE; END;',
      reference,
    ).bodyRequired,
    true,
  );
  assert.equal(
    declarationAuthid(
      'PROCEDURE p AUTHID CURRENT_USER AS BEGIN NULL; END;',
      reference,
      'PROCEDURE',
    ),
    'CURRENT_USER',
  );
  assert.equal(
    declarationAuthid(
      'PROCEDURE p AS BEGIN NULL; END;',
      reference,
      'PROCEDURE',
    ),
    'DEFINER',
  );
});

test('Unicode declaration identifiers and alternative delimiters remain intact', () => {
  const reference = { owner: 'APP', name: 'ΔΟΚΙΜΗ' };
  const source =
    "PROCEDURE δοκιμη AS v varchar2(20):=q'🙂$if🙂'; BEGIN NULL; END;";
  assert.equal(
    qualifyPlsqlSource(source, reference, 'PROCEDURE'),
    source.replace('δοκιμη', '"APP"."ΔΟΚΙΜΗ"'),
  );
});

test('local keyword-like identifiers do not imply wrapped or external code', () => {
  const source =
    'procedure p(wrapped number) as external number; language number; begin external := wrapped; language := external; end;';
  assert.doesNotThrow(() =>
    inspectPlsqlSource(source, { owner: 'APP', name: 'P' }, 'PROCEDURE'),
  );
});
