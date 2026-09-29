import {
  objectKey,
  type TargetDocument,
  type ObjectReference,
  type Prerequisite,
} from './model.js';

type Definitions = Pick<
  TargetDocument,
  'tables' | 'views' | 'programs' | 'sequences' | 'synonyms'
>;
export function includedType(
  document: Definitions,
  reference: ObjectReference,
): string | undefined {
  const key = objectKey(reference);
  if (document.synonyms.some((item) => objectKey(item.reference) === key))
    return 'SYNONYM';
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

/** Resolve only explicit SYNONYM facts; never guess aliases from matching names. */
export function resolveDependency<
  T extends {
    reference: ObjectReference;
    type: string;
    databaseLink?: string | null;
  },
>(document: Definitions, edge: T): T {
  if (edge.type !== 'SYNONYM' || edge.databaseLink) return edge;
  const synonym = document.synonyms.find(
    (item) => objectKey(item.reference) === objectKey(edge.reference),
  );
  const captured =
    synonym ??
    document.synonyms.find((item) =>
      item.resolution.some(
        (hop) =>
          hop.type === 'SYNONYM' &&
          objectKey(hop.reference) === objectKey(edge.reference),
      ),
    );
  const terminal = captured?.resolution.at(-1);
  return terminal
    ? { ...edge, reference: terminal.reference, type: terminal.type }
    : edge;
}

/** Facts remain in the artifact; resolution is always recomputed by consumers. */
export function allPrerequisites(
  document: TargetDocument,
): (Prerequisite & { directAccess?: boolean })[] {
  const facts: (Prerequisite & { directAccess?: boolean })[] = [
    ...document.synonyms.flatMap((synonym) =>
      synonym.resolution.map((hop) => ({
        requiredBy: synonym.reference,
        reference: hop.reference,
        type: hop.type,
        databaseLink: null,
      })),
    ),
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
  return facts.flatMap((edge) => {
    const resolved = resolveDependency(document, edge);
    if (resolved === edge) return [edge];
    const program = document.programs.some(
      (item) => objectKey(item.reference) === objectKey(edge.requiredBy),
    );
    return [
      { ...edge, directAccess: false },
      {
        ...resolved,
        directAccess:
          program && resolved.reference.owner !== edge.requiredBy.owner,
      },
    ];
  });
}
