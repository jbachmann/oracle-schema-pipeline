import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type ObjectReference,
  type TargetDocument,
  type ViewDependency,
} from './model.js';
import {
  grantKey,
  objectGrants,
  type EffectiveGrant,
} from './object-grants.js';
import { providerIndex, resolveProvider } from './providers.js';
import { schemaOwners } from './schema-owners.js';

export interface CreationOperation {
  id: string;
  type: string;
  reference: ObjectReference;
  priority: number;
  dependencies: Set<string>;
  parent?: ObjectReference;
  name?: string;
  grant?: EffectiveGrant;
}
export const operationId = (
  type: string,
  reference: ObjectReference,
  name?: string,
): string =>
  JSON.stringify([type, reference.owner, reference.name, name ?? null]);

/** One operation graph preserves relational provenance while scheduling mixed slices. */
export function operationOrder(document: TargetDocument): {
  operations: CreationOperation[];
  diagnostics: Diagnostic[];
} {
  const nodes = new Map<string, CreationOperation>();
  const diagnostics: Diagnostic[] = [];
  const providers = providerIndex(document);
  const add = (
    type: string,
    reference: ObjectReference,
    priority: number,
    extra: Partial<CreationOperation> = {},
  ) => {
    const id = operationId(type, reference, extra.name);
    const node = {
      id,
      type,
      reference,
      priority,
      dependencies: new Set<string>(),
      ...extra,
    };
    nodes.set(id, node);
    return node;
  };
  const ownerId = (owner: string) =>
    operationId('SCHEMA', { owner, name: owner });
  const owned = (node: CreationOperation) => {
    node.dependencies.add(ownerId(node.reference.owner));
    return node;
  };
  for (const owner of schemaOwners(document))
    add('SCHEMA', { owner, name: owner }, 0);
  for (const sequence of document.sequences)
    owned(add('SEQUENCE', sequence.reference, 1));
  for (const synonym of document.synonyms)
    owned(add('SYNONYM', synonym.reference, 2));
  for (const table of document.tables) {
    owned(add('TABLE', table.reference, 10));
    const comments = add('COMMENTS', table.reference, 20);
    comments.dependencies.add(operationId('TABLE', table.reference));
    for (const index of table.indexes) {
      const node = owned(
        add('INDEX', index.reference, 30, { parent: table.reference }),
      );
      node.dependencies.add(operationId('TABLE', table.reference));
    }
    for (const constraint of table.constraints) {
      if (constraint.kind === 'not-null') continue;
      const node = add(
        constraint.kind === 'foreign-key' ? 'FOREIGN KEY' : 'CONSTRAINT',
        table.reference,
        constraint.kind === 'foreign-key' ? 50 : 40,
        { name: constraint.name },
      );
      node.dependencies.add(operationId('TABLE', table.reference));
      if (constraint.kind === 'primary-key' || constraint.kind === 'unique') {
        if (constraint.backingIndex)
          node.dependencies.add(operationId('INDEX', constraint.backingIndex));
      }
      if (constraint.kind === 'foreign-key') {
        node.dependencies.add(operationId('TABLE', constraint.parentTable));
        node.dependencies.add(
          operationId(
            'CONSTRAINT',
            constraint.parentTable,
            constraint.parentConstraint.name,
          ),
        );
      }
    }
  }
  for (const view of document.views) owned(add('VIEW', view.reference, 60));
  for (const unit of document.programUnits) {
    const node = owned(
      add(unit.type, unit.reference, unit.type === 'PACKAGE BODY' ? 80 : 70),
    );
    if (unit.type === 'PACKAGE BODY')
      node.dependencies.add(operationId('PACKAGE', unit.reference));
  }
  const grants = objectGrants(document).grants;
  for (const grant of grants) {
    const node = add(
      'GRANT',
      grant.reference,
      grant.explicit
        ? 3
        : grant.privilege === 'EXECUTE'
          ? 25
          : grant.privilege === 'REFERENCES'
            ? 45
            : 59,
      { name: grantKey(grant), grant },
    );
    const provider = providers.get(objectKey(grant.reference));
    if (provider && !provider.external)
      node.dependencies.add(operationId(provider.type, grant.reference));
    node.dependencies.add(ownerId(grant.grantee));
  }
  const dependency = (
    node: CreationOperation,
    edge: ViewDependency,
    callCapable = false,
    recursive = false,
  ) => {
    const { provider, aliases } = resolveProvider(document, edge);
    for (const alias of aliases)
      if (
        document.synonyms.some(
          (item) => objectKey(item.reference) === objectKey(alias),
        )
      )
        node.dependencies.add(operationId('SYNONYM', alias));
    if (!provider) return;
    if (!provider.external) {
      const id = operationId(provider.type, provider.reference);
      if (!(recursive && id === node.id)) node.dependencies.add(id);
      if (
        callCapable &&
        provider.type === 'PACKAGE' &&
        document.programUnits.some(
          (unit) =>
            unit.type === 'PACKAGE BODY' &&
            objectKey(unit.reference) === objectKey(provider.reference),
        )
      )
        node.dependencies.add(operationId('PACKAGE BODY', provider.reference));
    }
    for (const grant of grants)
      if (
        grant.grantee === node.reference.owner &&
        objectKey(grant.reference) === objectKey(provider.reference)
      )
        node.dependencies.add(
          operationId('GRANT', grant.reference, grantKey(grant)),
        );
  };
  for (const table of document.tables) {
    for (const edge of table.dependencies)
      dependency(nodes.get(operationId('TABLE', table.reference))!, edge, true);
    for (const index of table.indexes)
      for (const edge of index.dependencies)
        dependency(
          nodes.get(operationId('INDEX', index.reference))!,
          edge,
          true,
        );
    for (const constraint of table.constraints)
      if (constraint.kind === 'foreign-key')
        dependency(
          nodes.get(
            operationId('FOREIGN KEY', table.reference, constraint.name),
          )!,
          {
            reference: constraint.parentTable,
            type: 'TABLE',
            databaseLink: null,
          },
        );
  }
  for (const view of document.views)
    for (const edge of view.dependencies)
      dependency(nodes.get(operationId('VIEW', view.reference))!, edge, true);
  for (const unit of document.programUnits)
    for (const edge of unit.dependencies)
      if (!edge.oracleMaintained)
        dependency(
          nodes.get(operationId(unit.type, unit.reference))!,
          edge,
          false,
          true,
        );
  // Ignore nonexistent nodes here: semantic coverage diagnostics identify them.
  for (const node of nodes.values())
    for (const id of node.dependencies)
      if (!nodes.has(id)) node.dependencies.delete(id);
  const operations: CreationOperation[] = [],
    pending = new Set(nodes.keys());
  const ordinalKey = (node: CreationOperation) =>
    JSON.stringify([
      node.parent?.owner ?? node.reference.owner,
      node.parent?.name ?? node.reference.name,
      node.reference.owner,
      node.reference.name,
      node.type,
      node.name ?? '',
    ]);
  const compare = (a: CreationOperation, b: CreationOperation) =>
    a.priority - b.priority ||
    (ordinalKey(a) < ordinalKey(b)
      ? -1
      : ordinalKey(a) > ordinalKey(b)
        ? 1
        : 0);
  while (pending.size) {
    const ready = [...pending]
      .map((id) => nodes.get(id)!)
      .filter((node) => [...node.dependencies].every((id) => !pending.has(id)))
      .sort(compare);
    if (!ready.length) break;
    // Reconsider newly ready operations to preserve phase priority at every step.
    operations.push(ready[0]);
    pending.delete(ready[0].id);
  }
  if (pending.size) {
    // DFS identifies an actual cycle, excluding operations merely blocked by it.
    const active = new Set<string>(),
      visited = new Set<string>(),
      path: string[] = [];
    let cycle: string[] = [];
    const visit = (id: string): boolean => {
      if (active.has(id)) {
        cycle = path.slice(path.indexOf(id));
        return true;
      }
      if (visited.has(id)) return false;
      visited.add(id);
      active.add(id);
      path.push(id);
      for (const dep of [...nodes.get(id)!.dependencies].sort())
        if (pending.has(dep) && visit(dep)) return true;
      active.delete(id);
      path.pop();
      return false;
    };
    for (const id of [...pending].sort()) if (visit(id)) break;
    diagnostics.push({
      severity: 'error',
      code: 'OBJECT_DEPENDENCY_CYCLE',
      object: 'document',
      message:
        'Creation cycle: ' +
        cycle
          .map((id) => {
            const node = nodes.get(id)!;
            return `${node.type} ${qualifiedName(node.reference)}${node.name && node.type !== 'GRANT' ? '/' + node.name : ''}`;
          })
          .join(' -> '),
    });
  }
  return { operations, diagnostics };
}
