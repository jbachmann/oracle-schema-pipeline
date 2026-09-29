import type { TargetDocument } from './model.js';

/** Owners of included objects only; prerequisite and unresolved references do not provision schemas. */
export function schemaOwners(
  document: Pick<TargetDocument, 'tables' | 'views' | 'programs' | 'sequences'>,
): string[] {
  return [
    ...new Set([
      ...document.tables.map((table) => table.reference.owner),
      ...document.programs.map((program) => program.reference.owner),
      ...document.sequences.map((sequence) => sequence.reference.owner),
      ...document.views.map((view) => view.reference.owner),
      ...document.tables.flatMap((table) =>
        table.indexes.map((index) => index.reference.owner),
      ),
    ]),
  ].sort();
}
