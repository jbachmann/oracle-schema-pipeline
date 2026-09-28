import {
  objectKey,
  qualifiedName,
  quoteIdentifier,
  type Diagnostic,
  type ObjectReference,
  type TargetDocument,
} from './model.js';

export interface IndexGrant {
  privilege: 'EXECUTE';
  reference: ObjectReference;
  grantee: string;
}
export function renderIndexGrant(grant: IndexGrant): string {
  return `GRANT ${grant.privilege} ON ${qualifiedName(grant.reference)} TO ${quoteIdentifier(grant.grantee)};`;
}

/** Derive exact grants offline; dependency metadata never confers executor authority. */
export function indexRequirements(document: TargetDocument): {
  grants: IndexGrant[];
  diagnostics: Diagnostic[];
} {
  const grants = new Map<string, IndexGrant>();
  const diagnostics: Diagnostic[] = [];
  for (const table of document.tables) {
    for (const index of table.indexes) {
      const dependencyTypes = new Map<string, Set<string>>();
      for (const edge of index.dependencies) {
        const key = JSON.stringify([
          objectKey(edge.reference),
          edge.databaseLink,
        ]);
        const types = dependencyTypes.get(key) ?? new Set<string>();
        types.add(edge.type);
        dependencyTypes.set(key, types);
      }
      for (const edge of index.dependencies) {
        if (edge.oracleMaintained && !edge.databaseLink) continue;
        const error = (code: string, message: string) =>
          diagnostics.push({
            severity: 'error',
            code,
            object: qualifiedName(index.reference),
            message,
          });
        if (
          dependencyTypes.get(
            JSON.stringify([objectKey(edge.reference), edge.databaseLink]),
          )!.size > 1
        ) {
          error(
            'UNSUPPORTED_INDEX_DEPENDENCY',
            `Ambiguous dependency types for ${qualifiedName(edge.reference)}.`,
          );
          continue;
        }
        if (
          edge.databaseLink !== null ||
          !['FUNCTION', 'PACKAGE'].includes(edge.type) ||
          !['FUNCTION-BASED NORMAL', 'FUNCTION-BASED BITMAP'].includes(
            index.type,
          )
        ) {
          error(
            'UNSUPPORTED_INDEX_DEPENDENCY',
            `Unsupported ${edge.type} dependency ${qualifiedName(edge.reference)}; direct local FUNCTION or PACKAGE metadata is required.`,
          );
          continue;
        }
        const matches = (item: { reference: ObjectReference; type: string }) =>
          item.type === edge.type &&
          objectKey(item.reference) === objectKey(edge.reference);
        if (
          !document.programs.some(
            (program) =>
              program.kind.toUpperCase() === edge.type &&
              objectKey(program.reference) === objectKey(edge.reference),
          ) &&
          (!document.prerequisites.some(
            (item) =>
              matches(item) &&
              item.databaseLink === null &&
              objectKey(item.requiredBy) === objectKey(table.reference),
          ) ||
            !document.policy.externalPrerequisites.some(matches))
        ) {
          error(
            'UNACKNOWLEDGED_PREREQUISITE',
            `Record and acknowledge ${edge.type} ${qualifiedName(edge.reference)} required by ${qualifiedName(table.reference)}.`,
          );
        }
        if (edge.reference.owner !== index.reference.owner) {
          const grant: IndexGrant = {
            privilege: 'EXECUTE',
            reference: edge.reference,
            grantee: index.reference.owner,
          };
          grants.set(
            JSON.stringify([
              grant.privilege,
              grant.reference.owner,
              grant.reference.name,
              grant.grantee,
            ]),
            grant,
          );
        }
      }
    }
  }
  return {
    grants: [...grants.values()].sort((left, right) => {
      const leftFields = [
        left.privilege,
        left.reference.owner,
        left.reference.name,
        left.grantee,
      ];
      const rightFields = [
        right.privilege,
        right.reference.owner,
        right.reference.name,
        right.grantee,
      ];
      for (let position = 0; position < leftFields.length; position++) {
        if (leftFields[position] !== rightFields[position]) {
          return leftFields[position] < rightFields[position] ? -1 : 1;
        }
      }
      return 0;
    }),
    diagnostics,
  };
}
