import { assertPreparedTarget } from './validate.js';

/** Pure SQL generation from an independently parsed and validated target model. */
export function generateSql(input: unknown): string {
  const { preparation } = assertPreparedTarget(input);
  return (
    preparation.operations.map((operation) => operation.sql).join('\n\n') + '\n'
  );
}
