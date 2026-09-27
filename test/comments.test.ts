import assert from 'node:assert/strict';
import test from 'node:test';
import { renderComment } from '../src/comments.js';

const reference = { owner: 'APP', name: 'T' };

test('table and column comments quote identifiers and comment text', () => {
  assert.equal(
    renderComment(reference, null, "Customer's orders"),
    `COMMENT ON TABLE "APP"."T" IS 'Customer''s orders';`,
  );
  assert.equal(
    renderComment({ owner: 'A"B', name: 'T"C' }, 'C"D', "it's & theirs"),
    `COMMENT ON COLUMN "A""B"."T""C"."C""D" IS 'it''s & theirs';`,
  );
});

test('direct SQL includes its semicolon in the 2400-byte line limit', () => {
  const direct = renderComment(reference, null, 'x'.repeat(2367));
  assert.equal(direct, `COMMENT ON TABLE "APP"."T" IS '${'x'.repeat(2367)}';`);
  assert.equal(Buffer.byteLength(direct, 'utf8'), 2400);
  assert.equal(
    renderComment(reference, null, 'x'.repeat(2368)),
    `BEGIN\n  EXECUTE IMMEDIATE\n    'COMMENT ON TABLE "APP"."T" IS ''${'x'.repeat(1768)}' ||\n    '${'x'.repeat(600)}''';\nEND;\n/`,
  );
});

test('dynamic chunks account for both layers of apostrophe escaping', () => {
  assert.equal(
    renderComment(reference, null, "'".repeat(1200)),
    `BEGIN\n  EXECUTE IMMEDIATE\n    'COMMENT ON TABLE "APP"."T" IS ${"'".repeat(1770)}' ||\n    '${"'".repeat(1800)}' ||\n    '${"'".repeat(1234)}';\nEND;\n/`,
  );
});

test('line breaks preserve CR, LF, and CRLF as separate expressions', () => {
  for (const [lineBreak, expression] of [
    ['\r', 'CHR(13)'],
    ['\n', 'CHR(10)'],
    ['\r\n', 'CHR(13) ||\n    CHR(10)'],
  ]) {
    assert.equal(
      renderComment(reference, null, `a${lineBreak}b`),
      `BEGIN\n  EXECUTE IMMEDIATE\n    'COMMENT ON TABLE "APP"."T" IS ''a' ||\n    ${expression} ||\n    'b''';\nEND;\n/`,
    );
  }
});

test('Unicode uses UTF-16 escapes without empty literals between characters', () => {
  assert.equal(
    renderComment(reference, null, 'Ω😀'),
    `BEGIN\n  EXECUTE IMMEDIATE\n    'COMMENT ON TABLE "APP"."T" IS ''' ||\n    UNISTR('\\03A9') ||\n    UNISTR('\\D83D\\DE00') ||\n    '''';\nEND;\n/`,
  );
});

test('chunk byte counts reset after Unicode and line breaks', () => {
  for (const [separator, expression] of [
    ['Ω', "UNISTR('\\03A9')"],
    ['\r', 'CHR(13)'],
    ['\n', 'CHR(10)'],
  ]) {
    assert.equal(
      renderComment(
        reference,
        null,
        `${'x'.repeat(1767)}${separator}${'y'.repeat(1799)}'z`,
      ),
      `BEGIN\n  EXECUTE IMMEDIATE\n    'COMMENT ON TABLE "APP"."T" IS ''${'x'.repeat(1767)}' ||\n    ${expression} ||\n    '${'y'.repeat(1799)}' ||\n    '''''z''';\nEND;\n/`,
    );
  }
});

test('empty comments are rejected', () => {
  assert.throws(() => renderComment(reference, null, ''), {
    message: 'Oracle stores an empty comment as null.',
  });
});

test('dynamic SQL accepts 32767 bytes and rejects larger statements', () => {
  // The unterminated statement adds 32 bytes to the comment text.
  const sql = renderComment(reference, null, 'x'.repeat(32767 - 32));
  assert.ok(sql.startsWith('BEGIN\n  EXECUTE IMMEDIATE\n'));
  assert.ok(
    sql.split('\n').every((line) => Buffer.byteLength(line, 'utf8') <= 2400),
  );
  for (const comment of [
    'x'.repeat(32768 - 32),
    'Ω'.repeat(16368),
    "'".repeat(16368),
  ]) {
    assert.throws(() => renderComment(reference, null, comment), {
      message: 'Comment DDL exceeds Oracle EXECUTE IMMEDIATE size.',
    });
  }
});
