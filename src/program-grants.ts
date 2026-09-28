import {
  objectKey,
  qualifiedName,
  quoteIdentifier,
  type TargetDocument,
  type ObjectReference,
  type Diagnostic,
} from './model.js';

export interface ProgramGrant {
  reference: ObjectReference;
  grantee: string;
  privilege:
    'EXECUTE' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'REFERENCES';
}
export function renderProgramGrant(grant: ProgramGrant): string {
  return `GRANT ${grant.privilege} ON ${qualifiedName(grant.reference)} TO ${quoteIdentifier(grant.grantee)};`;
}
export function programRequirements(document: TargetDocument) {
  const grants = new Map<string, ProgramGrant>();
  const diagnostics: Diagnostic[] = [];
  const requests =
    document.policy.version === 2 ? document.policy.plsqlObjectGrants : [];
  const used = new Set<number>();
  const add = (grant: ProgramGrant) => {
    if (grant.grantee === 'PUBLIC') {
      diagnostics.push({
        severity: 'error',
        code: 'PLSQL_REQUIRED_GRANT',
        object: qualifiedName(grant.reference),
        message: 'Program grants to PUBLIC are unsupported.',
      });
      return;
    }
    grants.set(renderProgramGrant(grant), grant);
  };
  for (const program of document.programs) {
    for (const edge of program.units.flatMap((unit) => unit.dependencies)) {
      if (
        edge.databaseLink ||
        edge.oracleMaintained ||
        edge.reference.owner === program.reference.owner
      )
        continue;
      if (['PROCEDURE', 'FUNCTION', 'PACKAGE'].includes(edge.type)) {
        if (
          document.programs.some(
            (included) =>
              objectKey(included.reference) === objectKey(edge.reference) &&
              included.kind.toUpperCase() === edge.type,
          )
        )
          add({
            reference: edge.reference,
            grantee: program.reference.owner,
            privilege: 'EXECUTE',
          });
      } else if (['TABLE', 'VIEW'].includes(edge.type)) {
        let found = false;
        requests.forEach((request, index) => {
          if (
            request.grantee !== program.reference.owner ||
            objectKey(request.reference) !== objectKey(edge.reference)
          )
            return;
          found = true;
          used.add(index);
          for (const privilege of request.privileges)
            add({
              reference: request.reference,
              grantee: request.grantee,
              privilege,
            });
        });
        diagnostics.push({
          severity: found ? 'warning' : 'error',
          code: found ? 'PLSQL_PRIVILEGE_REVIEW' : 'PLSQL_REQUIRED_GRANT',
          object: qualifiedName(program.reference),
          message: found
            ? 'Review explicit table/view grants for sufficient privileges; catalog edges do not identify required DML privileges.'
            : 'Cross-owner table/view dependency requires an explicit policy grant.',
        });
      }
    }
  }
  requests.forEach((request, index) => {
    if (!used.has(index) || request.grantee === 'PUBLIC')
      diagnostics.push({
        severity: 'error',
        code: 'PLSQL_REQUIRED_GRANT',
        object: qualifiedName(request.reference),
        message: 'Policy grant is unrelated or has an unsupported grantee.',
      });
  });
  return {
    grants: [...grants]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value),
    diagnostics,
  };
}
