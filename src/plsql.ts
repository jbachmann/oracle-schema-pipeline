/** Narrow source inspection, not a PL/SQL parser or a security sandbox. */
import { qualifiedName, type ObjectReference } from './model.js';

export type ProgramUnitType =
  'PROCEDURE' | 'FUNCTION' | 'PACKAGE' | 'PACKAGE BODY';
export type PlsqlFailureCode =
  | 'PLSQL_MEMBER_NOT_FOUND'
  | 'PLSQL_SOURCE_MISMATCH'
  | 'UNSUPPORTED_PLSQL'
  | 'UNSUPPORTED_PLSQL_CONDITIONAL';

export class PlsqlSourceError extends Error {
  constructor(readonly code: PlsqlFailureCode) {
    // Never include source text: it may contain application secrets.
    super(code);
  }
}

export interface PlsqlToken {
  kind: 'identifier' | 'literal' | 'symbol';
  value: string;
  start: number;
  end: number;
}

function fail(code: PlsqlFailureCode = 'PLSQL_SOURCE_MISMATCH'): never {
  throw new PlsqlSourceError(code);
}

/** Comments and literals cannot masquerade as declaration or directive tokens. */
export function lexPlsql(source: string): PlsqlToken[] {
  const tokens: PlsqlToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const start = offset;
    const rest = source.slice(offset);
    if (/^\s/u.test(rest)) {
      offset++;
      continue;
    }
    if (rest.startsWith('--')) {
      while (offset < source.length && !/[\r\n]/u.test(source[offset]))
        offset++;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) fail();
      offset = end + 2;
      continue;
    }
    const alternative = /^(?:nq|q)'/iu.exec(rest);
    if (alternative) {
      const delimiterCode = source.codePointAt(offset + alternative[0].length);
      const delimiter =
        delimiterCode === undefined ? '' : String.fromCodePoint(delimiterCode);
      if (!delimiter || /\s|'/u.test(delimiter)) fail();
      const close =
        ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[
          delimiter
        ] ?? delimiter;
      const end = source.indexOf(
        `${close}'`,
        offset + alternative[0].length + delimiter.length,
      );
      if (end < 0) fail();
      offset = end + close.length + 1;
      tokens.push({ kind: 'literal', value: '', start, end: offset });
      continue;
    }
    const national = /^n'/iu.test(rest);
    if (source[offset] === "'" || national || source[offset] === '"') {
      if (national) offset++;
      const quote = source[offset++];
      let value = '';
      let closed = false;
      while (offset < source.length) {
        const character = source[offset++];
        if (character === quote) {
          if (source[offset] === quote) {
            value += quote;
            offset++;
          } else {
            closed = true;
            break;
          }
        } else value += character;
      }
      if (!closed) fail();
      tokens.push({
        kind: quote === '"' ? 'identifier' : 'literal',
        value: quote === '"' ? value : '',
        start,
        end: offset,
      });
      continue;
    }
    if (
      rest.startsWith('$$') ||
      /^\$(?:if|then|else|elsif|end|error)\b/iu.test(rest)
    ) {
      fail('UNSUPPORTED_PLSQL_CONDITIONAL');
    }
    const identifier = /^[\p{L}][\p{L}\p{N}\p{M}_$#]*/u.exec(rest);
    if (identifier) {
      offset += identifier[0].length;
      tokens.push({
        kind: 'identifier',
        value: identifier[0].toUpperCase(),
        start,
        end: offset,
      });
    } else {
      offset++;
      tokens.push({ kind: 'symbol', value: source[start], start, end: offset });
    }
  }
  return tokens;
}

export interface PlsqlDeclaration {
  nameStart: number;
  nameEnd: number;
  tokens: PlsqlToken[];
}

/** ALL_SOURCE starts with the unit kind, without CREATE or editionability. */
export function inspectPlsqlSource(
  source: string,
  reference: ObjectReference,
  type: ProgramUnitType,
): PlsqlDeclaration {
  const tokens = lexPlsql(source);
  let index = 0;
  const keyword = (word: string): boolean => {
    const token = tokens[index];
    if (
      token?.kind !== 'identifier' ||
      token.value !== word ||
      source[token.start] === '"'
    )
      return false;
    index++;
    return true;
  };
  for (const word of type.split(' ')) if (!keyword(word)) fail();
  const first = tokens[index++];
  if (first?.kind !== 'identifier') fail();
  let last = first;
  if (tokens[index]?.value === '.') {
    index++;
    last = tokens[index++];
    if (first.value !== reference.owner || last?.kind !== 'identifier') fail();
  }
  if (last.value !== reference.name) fail();
  const unquoted = (token: PlsqlToken, word: string) =>
    token.kind === 'identifier' &&
    token.value === word &&
    source[token.start] !== '"';
  const remaining = tokens.slice(index);
  const delimiter = remaining.findIndex(
    (token) => unquoted(token, 'AS') || unquoted(token, 'IS'),
  );
  let depth = 0;
  for (const token of remaining.slice(
    0,
    delimiter < 0 ? undefined : delimiter,
  )) {
    if (token.value === '(') depth++;
    if (token.value === ')') depth--;
    if (depth === 0 && unquoted(token, 'WRAPPED')) fail('UNSUPPORTED_PLSQL');
  }
  // Call specifications follow AS/IS, including nested package declarations.
  // Keyword-like local names elsewhere are not evidence of an external unit.
  for (let i = 0; i < remaining.length - 2; i++) {
    if (!unquoted(remaining[i], 'AS') && !unquoted(remaining[i], 'IS'))
      continue;
    const next = remaining[i + 1];
    const after = remaining[i + 2];
    if (
      (unquoted(next, 'EXTERNAL') &&
        (after.value === ';' ||
          unquoted(after, 'NAME') ||
          unquoted(after, 'LIBRARY'))) ||
      (unquoted(next, 'LANGUAGE') &&
        (unquoted(after, 'JAVA') || unquoted(after, 'C')))
    )
      fail('UNSUPPORTED_PLSQL');
  }
  // Require the envelope delimiter; full body grammar remains Oracle's job.
  if (delimiter < 0) fail();
  if (tokens.at(-1)?.value !== ';') fail();
  return { nameStart: first.start, nameEnd: last.end, tokens };
}

export function qualifyPlsqlSource(
  source: string,
  reference: ObjectReference,
  type: ProgramUnitType,
): string {
  const declaration = inspectPlsqlSource(source, reference, type);
  return (
    source.slice(0, declaration.nameStart) +
    qualifiedName(reference) +
    source.slice(declaration.nameEnd)
  );
}

/** Declaration evidence used both at extraction and independent validation. */
export function packageDeclarationEvidence(
  source: string,
  reference: ObjectReference,
) {
  const { tokens } = inspectPlsqlSource(source, reference, 'PACKAGE');
  const keyword = (index: number, value: string) =>
    tokens[index]?.kind === 'identifier' &&
    tokens[index].value === value &&
    source[tokens[index].start] !== '"';
  const procedures: string[] = [];
  let bodyRequired = false;
  for (let index = 0; index < tokens.length; index++) {
    if (keyword(index, 'PROCEDURE') || keyword(index, 'FUNCTION')) {
      bodyRequired = true;
      if (keyword(index, 'PROCEDURE')) {
        if (tokens[index + 1]?.kind !== 'identifier') fail();
        procedures.push(tokens[index + 1].value);
      }
    }
    if (keyword(index, 'CURSOR') && !keyword(index - 1, 'REF')) {
      // A public cursor declaration needs a body, but a cursor defined with its
      // query in the specification and a REF CURSOR type do not.
      let defined = false;
      for (
        let cursor = index + 1;
        cursor < tokens.length && tokens[cursor].value !== ';';
        cursor++
      )
        if (keyword(cursor, 'IS')) defined = true;
      if (!defined) bodyRequired = true;
    }
  }
  return { procedures, bodyRequired };
}

export function declarationAuthid(
  source: string,
  reference: ObjectReference,
  type: ProgramUnitType,
): 'DEFINER' | 'CURRENT_USER' {
  const { tokens, nameEnd } = inspectPlsqlSource(source, reference, type);
  const header = tokens.filter((token) => token.start >= nameEnd);
  for (let index = 0; index < header.length; index++) {
    const token = header[index];
    if (token.kind !== 'identifier' || source[token.start] === '"') continue;
    if (token.value === 'AS' || token.value === 'IS') break;
    if (token.value === 'AUTHID') {
      const value = header[index + 1];
      if (
        value?.kind !== 'identifier' ||
        source[value.start] === '"' ||
        !['DEFINER', 'CURRENT_USER'].includes(value.value)
      )
        fail();
      return value.value as 'DEFINER' | 'CURRENT_USER';
    }
  }
  return 'DEFINER';
}
