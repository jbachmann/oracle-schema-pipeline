import {
  objectKey,
  qualifiedName,
  quoteIdentifier,
  type Diagnostic,
  type ObjectReference,
  type TargetDocument,
} from './model.js';
import { providerIndex, resolveProvider } from './providers.js';
import { schemaOwners } from './schema-owners.js';
import { indexRequirements } from './index-grants.js';

export interface EffectiveGrant {
  reference: ObjectReference;
  grantee: string;
  privilege: string;
  explicit: boolean;
}
export function grantKey(grant: EffectiveGrant): string {
  return JSON.stringify([
    grant.reference.owner,
    grant.reference.name,
    grant.grantee,
    grant.privilege,
  ]);
}
export function renderObjectGrant(grant: EffectiveGrant): string {
  return `GRANT ${grant.privilege} ON ${qualifiedName(grant.reference)} TO ${quoteIdentifier(grant.grantee)};`;
}

export function objectGrants(document: TargetDocument): {
  grants: EffectiveGrant[];
  diagnostics: Diagnostic[];
} {
  const providers = providerIndex(document),
    owners = new Set(schemaOwners(document));
  const grants = new Map<string, EffectiveGrant>();
  const diagnostics: Diagnostic[] = [];
  const add = (grant: EffectiveGrant) => {
    const key = grantKey(grant);
    grants.set(key, {
      ...grant,
      explicit: grant.explicit || grants.get(key)?.explicit || false,
    });
  };
  for (const grant of document.policy.objectGrants) {
    const provider = providers.get(objectKey(grant.reference));
    const allowed = ['TABLE', 'VIEW'].includes(grant.type)
      ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      : grant.type === 'SEQUENCE'
        ? ['SELECT']
        : ['EXECUTE'];
    if (
      !provider ||
      provider.type !== grant.type ||
      !owners.has(grant.grantee) ||
      grant.grantee === 'PUBLIC' ||
      grant.grantee === grant.reference.owner ||
      grant.privileges.some((privilege) => !allowed.includes(privilege))
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_OBJECT_GRANT',
        object: qualifiedName(grant.reference),
        message:
          'Grant requires an exact included or acknowledged base object, supported privileges, and a different included schema owner.',
      });
      continue;
    }
    for (const privilege of grant.privileges)
      add({
        reference: grant.reference,
        grantee: grant.grantee,
        privilege,
        explicit: true,
      });
  }
  for (const grant of indexRequirements(document).grants)
    add({ ...grant, explicit: false });
  for (const view of document.views)
    for (const edge of view.dependencies) {
      const { provider } = resolveProvider(document, edge);
      if (provider && provider.reference.owner !== view.reference.owner)
        add({
          reference: provider.reference,
          grantee: view.reference.owner,
          privilege: ['FUNCTION', 'PACKAGE'].includes(provider.type)
            ? 'EXECUTE'
            : 'SELECT',
          explicit: false,
        });
    }
  for (const table of document.tables)
    for (const constraint of table.constraints)
      if (
        constraint.kind === 'foreign-key' &&
        constraint.parentTable.owner !== table.reference.owner
      )
        add({
          reference: constraint.parentTable,
          grantee: table.reference.owner,
          privilege: 'REFERENCES',
          explicit: false,
        });
  return {
    grants: [...grants.values()].sort((a, b) =>
      grantKey(a) < grantKey(b) ? -1 : grantKey(a) > grantKey(b) ? 1 : 0,
    ),
    diagnostics,
  };
}
