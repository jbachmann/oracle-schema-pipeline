import {
  quoteIdentifier,
  qualifiedName,
  type ObjectReference,
} from './model.js';

const lineLimit = 2400;
const chunkLimit = 1800;

function splitLiteral(value: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (character.codePointAt(0)! > 0x7f) {
      if (chunk) chunks.push(`'${chunk.replaceAll("'", "''")}'`);
      const escaped = character
        .split('')
        .map(
          (unit) =>
            `\\${unit.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`,
        )
        .join('');
      chunks.push(`UNISTR('${escaped}')`);
      chunk = '';
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (chunk) chunks.push(`'${chunk.replaceAll("'", "''")}'`);
      chunks.push(character === '\r' ? 'CHR(13)' : 'CHR(10)');
      chunk = '';
      continue;
    }
    const candidate = chunk + character;
    if (
      Buffer.byteLength(candidate.replaceAll("'", "''"), 'utf8') > chunkLimit
    ) {
      if (!chunk)
        throw new Error(
          'A comment character cannot be represented within the SQL input-line limit.',
        );
      chunks.push(`'${chunk.replaceAll("'", "''")}'`);
      chunk = character;
    } else chunk = candidate;
  }
  if (chunk || !chunks.length) chunks.push(`'${chunk.replaceAll("'", "''")}'`);
  return chunks;
}

export function renderComment(
  reference: ObjectReference,
  column: string | null,
  comment: string,
): string {
  if (comment.length === 0)
    throw new Error('Oracle stores an empty comment as null.');
  const subject =
    column === null
      ? `TABLE ${qualifiedName(reference)}`
      : `COLUMN ${qualifiedName(reference)}.${quoteIdentifier(column)}`;
  const direct = `COMMENT ON ${subject} IS '${comment.replaceAll("'", "''")}';`;
  if (
    !/[^\x00-\x7f]|[\r\n]/u.test(direct) &&
    Buffer.byteLength(direct, 'utf8') <= lineLimit
  )
    return direct;
  const dynamicSql = `COMMENT ON ${subject} IS '${comment.replaceAll("'", "''")}'`;
  if (Buffer.byteLength(dynamicSql, 'utf8') > 32767)
    throw new Error('Comment DDL exceeds Oracle EXECUTE IMMEDIATE size.');
  const parts = splitLiteral(dynamicSql);
  return `BEGIN\n  EXECUTE IMMEDIATE\n    ${parts.join(' ||\n    ')};\nEND;\n/`;
}
