/**
 * Collects the operations and diagnostics for one SQL preparation run. emit
 * retains statement order and object attribution while checking each physical
 * line against the conservative SQL*Plus UTF-8 byte limit. attemptRender turns
 * caught rendering failures into diagnostics so preparation can continue.
 *
 * Failed renders return empty strings, so collected operations may be incomplete.
 * validate.ts must reject errors before generate.ts assembles the final script.
 * This collector only records results; it performs no database or file I/O.
 */
import type { Diagnostic } from './model.js';

const sqlLineLimit = 2400;

interface SqlOperation {
  object: string;
  sql: string;
}

export interface SqlPreparation {
  operations: SqlOperation[];
  diagnostics: Diagnostic[];
}

export type AttemptRender = (
  code: string,
  object: string,
  render: () => string,
) => string;

export interface SqlCollector {
  emit: (object: string, ...statements: string[]) => void;
  attemptRender: AttemptRender;
  result: SqlPreparation;
}

export function createSqlPreparation(): SqlCollector {
  const operations: SqlOperation[] = [];
  const diagnostics: Diagnostic[] = [];

  function emit(object: string, ...statements: string[]): void {
    for (const sql of statements) {
      operations.push({ object, sql });
      for (const [index, line] of sql.split('\n').entries()) {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > sqlLineLimit) {
          diagnostics.push({
            severity: 'error',
            code: 'SQL_LINE_LIMIT',
            object,
            message: `Rendered SQL line ${index + 1} is ${bytes} UTF-8 bytes; the conservative SQL*Plus limit is ${sqlLineLimit} bytes.`,
          });
        }
      }
    }
  }

  const attemptRender: AttemptRender = (code, object, render) => {
    try {
      return render();
    } catch (reason) {
      diagnostics.push({
        severity: 'error',
        code,
        object,
        message: String(reason),
      });
      // This preparation is diagnostic-only when any renderer fails.
      return '';
    }
  };

  return { emit, attemptRender, result: { operations, diagnostics } };
}
