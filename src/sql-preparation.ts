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
