/** Test-only comparison: preserve every token, including quoted text/comments.
 * Ignore whitespace between tokens and redundant enclosing parentheses only.
 * This is not a SQL parser or a production SQL rewriting utility.
 */
export function comparableExpression(value: string | null): string | null {
  if (value === null) return null;
  const tokens: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (/\s/u.test(value[i])) {
      i++;
      continue;
    }
    const start = i;
    if (value.slice(i, i + 2) === '--') {
      i = value.indexOf('\n', i);
      if (i < 0) i = value.length;
    } else if (value.slice(i, i + 2) === '/*') {
      const end = value.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated SQL comment');
      i = end + 2;
    } else if (/^(?:n?q)'/iu.test(value.slice(i, i + 3))) {
      const quote = value.indexOf("'", i);
      const open = value[quote + 1];
      const close =
        ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[
          open
        ] ?? open;
      const end = value.indexOf(`${close}'`, quote + 2);
      if (end < 0) throw new Error('Unterminated SQL alternative quote');
      i = end + 2;
    } else if (value[i] === "'" || value[i] === '"') {
      const quote = value[i++];
      let closed = false;
      while (i < value.length) {
        if (value[i++] !== quote) continue;
        if (value[i] === quote) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
    } else if (/[\p{L}\p{N}_$#]/u.test(value[i])) {
      while (i < value.length && /[\p{L}\p{N}_$#]/u.test(value[i])) i++;
    } else {
      // Keep multi-character operators intact, so whitespace cannot invent one.
      const pair = value.slice(i, i + 2);
      i += ['||', '>=', '<=', '<>', '!=', ':=', '=>', '**', '..'].includes(pair)
        ? 2
        : 1;
    }
    tokens.push(value.slice(start, i));
  }
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] === '(') depth++;
      if (tokens[index] === ')') depth--;
      if (depth === 0 && index < tokens.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps || depth !== 0) break;
    tokens.shift();
    tokens.pop();
  }
  return JSON.stringify(tokens);
}
