import {
  objectKey,
  type TargetDocument,
  type ObjectReference,
  type Prerequisite,
} from './model.js';

type Definitions = Pick<
  TargetDocument,
  'tables' | 'views' | 'programs' | 'sequences'
>;
export function includedType(
  document: Definitions,
  reference: ObjectReference,
): string | undefined {
  const key = objectKey(reference);
  if (document.tables.some((item) => objectKey(item.reference) === key))
    return 'TABLE';
  if (document.views.some((item) => objectKey(item.reference) === key))
    return 'VIEW';
  if (document.sequences.some((item) => objectKey(item.reference) === key))
    return 'SEQUENCE';
  return document.programs.find((item) => objectKey(item.reference) === key)
    ?.kind;
}
export function isIncluded(
  document: Definitions,
  edge: {
    reference: ObjectReference;
    type: string;
    databaseLink?: string | null;
  },
): boolean {
  return (
    !edge.databaseLink && includedType(document, edge.reference) === edge.type
  );
}

/** Facts remain in the artifact; resolution is always recomputed by consumers. */
export function allPrerequisites(
  document: TargetDocument,
): (Prerequisite & { directAccess?: boolean })[] {
  return [
    ...document.prerequisites,
    ...document.views.flatMap((view) =>
      view.dependencies
        .filter((edge) => !['TABLE', 'VIEW'].includes(edge.type))
        .map((edge) => ({ ...edge, requiredBy: view.reference })),
    ),
    ...document.programs.flatMap((program) =>
      program.units.flatMap((unit) =>
        unit.dependencies
          .filter((edge) => edge.databaseLink || !edge.oracleMaintained)
          .map((edge) => ({
            ...edge,
            requiredBy: program.reference,
            directAccess: edge.reference.owner !== program.reference.owner,
          })),
      ),
    ),
  ];
}
