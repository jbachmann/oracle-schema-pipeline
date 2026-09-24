import oracle, { type BindParameters, type Connection } from 'oracledb';
import { z } from 'zod';

export type CatalogErrorCode =
  | 'CATALOG_UNKNOWN_VALUE'
  | 'CATALOG_CARDINALITY'
  | 'CATALOG_INCOMPLETE_METADATA';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    readonly object: string,
    readonly field: string,
    detail = '',
  ) {
    super(`${code}: ${object} [${field}]${detail ? `: ${detail}` : ''}`);
    this.name = 'CatalogError';
  }
}

export function catalogFailure(
  code: CatalogErrorCode,
  object: string,
  field: string,
  detail = '',
): never {
  throw new CatalogError(code, object, field, detail);
}

/** Read complete result sets and validate unknown driver values before assembly.
 * Error messages identify fields, never include raw SQL fragments or row values.
 */
export async function catalogRows<S extends z.ZodTypeAny>(
  connection: Connection,
  schema: S,
  sql: string,
  binds: BindParameters = {},
): Promise<z.infer<S>[]> {
  const context = Object.values(binds).join('.') || 'database';
  const result = await connection.execute<unknown>(sql, binds, {
    outFormat: oracle.OUT_FORMAT_OBJECT,
    resultSet: true,
  });
  const resultSet = result.resultSet;
  if (!resultSet)
    catalogFailure('CATALOG_INCOMPLETE_METADATA', context, 'resultSet');
  const rows: z.infer<S>[] = [];
  try {
    while (true) {
      const batch = await resultSet.getRows(100);
      if (!batch.length) return rows;
      for (const row of batch) {
        const decoded = schema.safeParse(row);
        if (!decoded.success) {
          const issue = decoded.error.issues[0];
          catalogFailure(
            issue.code === 'invalid_enum_value' ||
              issue.code === 'invalid_literal'
              ? 'CATALOG_UNKNOWN_VALUE'
              : 'CATALOG_INCOMPLETE_METADATA',
            context,
            issue.path.join('.') || 'row',
          );
        }
        rows.push(decoded.data);
      }
    }
  } finally {
    await resultSet.close();
  }
}

export function uniqueRows<T extends object>(
  rows: T[],
  fields: (keyof T)[],
  object: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(fields.map((field) => row[field]));
    if (seen.has(key))
      catalogFailure(
        'CATALOG_CARDINALITY',
        object,
        fields.join(','),
        'Duplicate identity',
      );
    seen.add(key);
  }
}

export function orderedRows<T extends object>(
  rows: T[],
  field: keyof T,
  object: string,
): void {
  if (!rows.length || rows.some((row, index) => row[field] !== index + 1))
    catalogFailure(
      'CATALOG_INCOMPLETE_METADATA',
      object,
      String(field),
      'Expected contiguous ordered members starting at 1',
    );
}

export function singleRow<T>(rows: T[], object: string, field: string): T {
  if (rows.length !== 1)
    catalogFailure(
      'CATALOG_CARDINALITY',
      object,
      field,
      `Expected one row, found ${rows.length}`,
    );
  return rows[0];
}
