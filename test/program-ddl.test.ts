import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clobAppendLines, renderProgram } from '../src/program-ddl.js';
import { program } from './program-fixtures.js';

test('CLOB transport reconstructs Unicode, quotes, control characters, and client commands exactly', () => {
  const text = `one's Ω😀\r\n/\nSET DEFINE ON\n${"'Ω😀".repeat(20000)}`;
  const lines = clobAppendLines(text);
  const reconstructed = lines
    .map((line) => {
      const code = /CHR\((\d+)\)/.exec(line);
      if (code) return String.fromCharCode(Number(code[1]));
      const literal = /LENGTH\('((?:''|[^'])*)'\)/.exec(line);
      assert.ok(literal);
      return literal[1].replaceAll("''", "'");
    })
    .join('');
  assert.equal(reconstructed, text);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 2400));
  assert.ok(lines.every((line) => !/^\s*\/$/.test(line)));
});

test('program wrapper parses DDL once, restores compiler settings, and frees both resources', () => {
  const sql = renderProgram(program());
  assert.equal(sql.match(/DBMS_SQL.PARSE/g)?.length, 1);
  assert.ok(!sql.includes('DBMS_SQL.EXECUTE'));
  assert.equal(sql.match(/DBMS_SQL.CLOSE_CURSOR/g)?.length, 2);
  assert.equal(sql.match(/DBMS_LOB.FREETEMPORARY/g)?.length, 2);
  assert.equal(sql.match(/  restore_settings;/g)?.length, 2);
  assert.match(sql, /attribute='ERROR'/);
  assert.ok(!sql.includes('OR REPLACE'));
});
