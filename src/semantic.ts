import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type TargetDocument,
  type ViewDefinition,
} from './model.js';

export const compareOrdinal = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Analyze modeled edges only; trusted SQL fragments are never parsed. */
export function analyzeTarget(document: TargetDocument) {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, object: string, message: string): void => {
    diagnostics.push({ severity: 'error', code, object, message });
  };
  const tablesByKey = new Map(
    document.tables.map((t) => [objectKey(t.reference), t]),
  );
  const viewsByKey = new Map(
    document.views.map((v) => [objectKey(v.reference), v]),
  );
  const tableTargets = new Set(document.targetTables.map(objectKey));
  const viewTargets = new Set(document.targetViews.map(objectKey));
  const expectedTables = new Set(tableTargets);
  const directParents = new Set<string>();
  const reachableViews = new Set<string>();
  if (tablesByKey.size !== document.tables.length)
    error('DUPLICATE_TABLE', 'document', 'Table identities must be unique.');
  if (viewsByKey.size !== document.views.length)
    error('DUPLICATE_VIEW', 'document', 'View identities must be unique.');
  for (const [roots, definitions] of [
    [document.targetTables, tablesByKey],
    [document.targetViews, viewsByKey],
  ] as const)
    for (const root of roots)
      if (!definitions.has(objectKey(root)))
        error(
          'MISSING_TARGET',
          qualifiedName(root),
          'Requested definition is absent.',
        );
  for (const key of tableTargets)
    for (const constraint of tablesByKey.get(key)?.constraints ?? [])
      if (constraint.kind === 'foreign-key') {
        const parent = objectKey(constraint.parentTable);
        expectedTables.add(parent);
        directParents.add(parent);
      }
  const queue = [...viewTargets];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    if (reachableViews.has(key)) continue;
    reachableViews.add(key);
    for (const edge of viewsByKey.get(key)?.dependencies ?? []) {
      if (edge.databaseLink) continue;
      if (edge.type === 'TABLE') expectedTables.add(objectKey(edge.reference));
      if (edge.type === 'VIEW') queue.push(objectKey(edge.reference));
    }
  }
  for (const table of document.tables) {
    const key = objectKey(table.reference),
      name = qualifiedName(table.reference);
    if (!expectedTables.has(key))
      error(
        'EXTRA_TABLE',
        name,
        'Table is outside the requested dependency closure.',
      );
    const role = tableTargets.has(key)
      ? 'target'
      : directParents.has(key)
        ? 'direct-parent'
        : 'view-dependency';
    if (table.role !== role)
      error(
        'ROLE_MISMATCH',
        name,
        'Table role disagrees with requested dependency closure.',
      );
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const view of document.views) {
    const key = objectKey(view.reference),
      name = qualifiedName(view.reference);
    if (tablesByKey.has(key))
      error(
        'OBJECT_NAME_COLLISION',
        name,
        'Tables and views share a schema namespace.',
      );
    if (!reachableViews.has(key))
      error(
        'EXTRA_VIEW',
        name,
        'View is outside the requested dependency closure.',
      );
    if (view.role !== (viewTargets.has(key) ? 'target' : 'dependency'))
      error('ROLE_MISMATCH', name, 'View role disagrees with target list.');
    if (view.status !== 'VALID')
      error('INVALID_VIEW', name, 'Cannot reconstruct invalid view.');
    if (new Set(view.columns).size !== view.columns.length)
      error('DUPLICATE_VIEW_COLUMN', name, 'View column names must be unique.');
    for (const flag of [
      'editioning',
      'typed',
      'superview',
      'containerData',
    ] as const)
      if (view[flag])
        error(
          'UNSUPPORTED_VIEW',
          name,
          `Unsupported specialized view flag: ${flag}.`,
        );
    if (view.readOnly && view.checkOption !== 'NONE')
      error(
        'UNSUPPORTED_VIEW',
        name,
        'READ ONLY and CHECK OPTION cannot both be preserved.',
      );
    if (view.collation && view.collation !== 'USING_NLS_COMP')
      error(
        'UNSUPPORTED_COLLATION',
        name,
        `Explicit collation ${view.collation} requires a target policy.`,
      );
    for (const feature of view.unsupportedFeatures)
      error('UNSUPPORTED_VIEW', name, feature);
    const dependencies = new Set<string>();
    for (const edge of view.dependencies) {
      if (edge.databaseLink)
        error(
          'REMOTE_VIEW_DEPENDENCY',
          name,
          'Remote view dependency is unsupported.',
        );
      else if (edge.type === 'TABLE' || edge.type === 'VIEW') {
        const dependency = objectKey(edge.reference);
        if (!(edge.type === 'TABLE' ? tablesByKey : viewsByKey).has(dependency))
          error(
            'MISSING_VIEW_DEPENDENCY',
            name,
            `Required ${edge.type} ${qualifiedName(edge.reference)} is absent.`,
          );
        else if (edge.type === 'VIEW') dependencies.add(dependency);
      } else
        error(
          'UNSUPPORTED_VIEW_DEPENDENCY',
          name,
          'Only TABLE and VIEW dependencies are supported.',
        );
    }
    indegree.set(key, dependencies.size);
    for (const dependency of dependencies) {
      const children = dependents.get(dependency) ?? [];
      children.push(key);
      dependents.set(dependency, children);
    }
  }
  // Sorted layers preserve deterministic ordering without rescanning pending nodes.
  let ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  const orderedViews: ViewDefinition[] = [];
  while (ready.length) {
    const next: string[] = [];
    for (const key of ready.sort(compareOrdinal)) {
      orderedViews.push(viewsByKey.get(key)!);
      for (const child of dependents.get(key) ?? []) {
        const count = indegree.get(child)! - 1;
        indegree.set(child, count);
        if (count === 0) next.push(child);
      }
    }
    ready = next;
  }
  if (orderedViews.length !== viewsByKey.size)
    error(
      'VIEW_DEPENDENCY_CYCLE',
      'document',
      'View dependency graph contains a cycle.',
    );
  return {
    tablesByKey,
    viewsByKey,
    expectedTables,
    reachableViews,
    orderedViews,
    diagnostics,
  };
}
