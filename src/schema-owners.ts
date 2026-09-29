import type { TargetDocument } from './model.js';

/** Owners of included objects only; prerequisite and unresolved references do not provision schemas. */
export function schemaOwners(
  document: Pick<
    TargetDocument,
    'tables' | 'views' | 'programUnits' | 'sequences' | 'synonyms'
  >,
): string[] {
  return [
    ...new Set([
      ...document.programUnits.map((unit) => unit.reference.owner),
      ...document.sequences.map((sequence) => sequence.reference.owner),
      ...document.synonyms.map((synonym) => synonym.reference.owner),
      ...document.tables.map((table) => table.reference.owner),
      ...document.views.map((view) => view.reference.owner),
      ...document.tables.flatMap((table) =>
        table.indexes.map((index) => index.reference.owner),
      ),
    ]),
  ].sort();
}
