/**
 * Render extracted table and column comments as Oracle DDL, preserving their text.
 * SQL preparation uses this module to emit comments after tables and before indexes;
 * rendering failures become diagnostics that block generation.
 *
 * Short, single-line ASCII statements use COMMENT ON directly. Longer statements,
 * line breaks, and Unicode use a PL/SQL expression that keeps generated input lines
 * bounded. This module only renders document metadata and never connects to Oracle.
 */
import {
  quoteIdentifier,
  qualifiedName,
  type ObjectReference,
} from './model.js';

// Keep physical lines within the pipeline's SQL*Plus input-line limit.
const maxSqlLineBytes = 2400;
// Escaped literal content leaves room for quotes, indentation, and concatenation.
const maxEscapedChunkBytes = 1800;
// Bound the statement passed to EXECUTE IMMEDIATE before wrapping it in PL/SQL.
const maxDynamicSqlBytes = 32767;

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderUnicodeCharacter(character: string): string {
  // UNISTR escapes UTF-16 code units; supplementary characters need both surrogates.
  const escaped = character
    .split('')
    .map(
      (unit) =>
        `\\${unit.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`,
    )
    .join('');
  return `UNISTR('${escaped}')`;
}

/**
 * Build SQL expressions whose concatenation reconstructs the complete DDL text.
 * Quoted chunks hold ASCII text, CHR preserves line breaks, and UNISTR represents
 * Unicode without embedding non-ASCII characters in the generated script.
 */
export function renderSqlStringParts(
  value: string,
  encodeControls = false,
): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let escapedChunkBytes = 0;

  const flushChunk = (): void => {
    if (chunk) {
      chunks.push(quoteSqlLiteral(chunk));
      chunk = '';
      escapedChunkBytes = 0;
    }
  };

  for (const character of value) {
    // Keep literal chunks ASCII-only so replay does not depend on file encoding.
    if (character.codePointAt(0)! > 0x7f) {
      flushChunk();
      chunks.push(renderUnicodeCharacter(character));
      continue;
    }

    if (encodeControls && /[\x00-\x1f\x7f]/u.test(character)) {
      flushChunk();
      chunks.push(`CHR(${character.charCodeAt(0)})`);
      continue;
    }
    if (character === '\r' || character === '\n') {
      flushChunk();
      chunks.push(character === '\r' ? 'CHR(13)' : 'CHR(10)');
      continue;
    }

    // Remaining characters are ASCII; an apostrophe doubles when quoted.
    const escapedCharacterBytes = character === "'" ? 2 : 1;
    if (escapedChunkBytes + escapedCharacterBytes > maxEscapedChunkBytes) {
      if (!chunk) {
        throw new Error(
          'A comment character cannot be represented within the SQL input-line limit.',
        );
      }
      flushChunk();
    }
    chunk += character;
    escapedChunkBytes += escapedCharacterBytes;
  }

  flushChunk();
  if (!chunks.length) {
    chunks.push(quoteSqlLiteral(''));
  }
  return chunks;
}

/**
 * Render one present comment; a null column selects the table itself.
 * Callers omit absent (null) comments. Empty text is rejected because Oracle would
 * remove the comment, and oversized dynamic statements fail rather than truncate.
 * The result includes the statement terminator or the PL/SQL block's slash line.
 */
export function renderComment(
  reference: ObjectReference,
  column: string | null,
  comment: string,
): string {
  if (comment.length === 0) {
    throw new Error('Oracle stores an empty comment as null.');
  }

  const subject =
    column === null
      ? `TABLE ${qualifiedName(reference)}`
      : `COLUMN ${qualifiedName(reference)}.${quoteIdentifier(column)}`;
  const dynamicSql = `COMMENT ON ${subject} IS ${quoteSqlLiteral(comment)}`;
  const direct = `${dynamicSql};`;
  if (
    !/[^\x00-\x7f]|[\r\n]/u.test(direct) &&
    Buffer.byteLength(direct, 'utf8') <= maxSqlLineBytes
  ) {
    return direct;
  }

  if (Buffer.byteLength(dynamicSql, 'utf8') > maxDynamicSqlBytes) {
    throw new Error('Comment DDL exceeds Oracle EXECUTE IMMEDIATE size.');
  }

  // Quote the complete statement again for the enclosing PL/SQL expression.
  const parts = renderSqlStringParts(dynamicSql);
  return `BEGIN\n  EXECUTE IMMEDIATE\n    ${parts.join(' ||\n    ')};\nEND;\n/`;
}
