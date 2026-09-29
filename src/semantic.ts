import { validatePrograms } from './programs.js';
import { validateSequences } from './sequences.js';
import { validateProviders, resolveProvider } from './providers.js';
import { objectGrants } from './object-grants.js';
import { operationOrder } from './operation-order.js';
/**
 * Semantic analysis checks the meaning and relationships of parsed metadata.
 * The schemas in model.ts check document shape; this module checks whether
 * requested objects exist, dependencies stay within the allowed scope, object
 * roles agree with that scope, and views use supported metadata.
 *
 * validate.ts combines these diagnostics with column, constraint, and index
 * checks. SQL preparation reuses the analysis to emit views in deterministic
 * dependency order. Analysis is entirely offline and follows only modeled
 * references; SQL text and expressions remain trusted, opaque fragments.
 */
import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type TableDefinition,
  type TargetDocument,
  type ViewDefinition,
} from './model.js';

export const compareOrdinal = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

type ReportError = (code: string, object: string, message: string) => void;

/**
 * Return object indexes, dependency closure, ordered views, and diagnostics.
 * The closure contains requested tables, their direct foreign-key parents,
 * and tables/views reached from requested views. Invalid documents still
 * produce analysis results; callers must check diagnostics before generation.
 */
export function analyzeTarget(document: TargetDocument) {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, object: string, message: string): void => {
    diagnostics.push({ severity: 'error', code, object, message });
  };
  const tablesByKey = new Map(
    document.tables.map((table) => [objectKey(table.reference), table]),
  );
  const viewsByKey = new Map(
    document.views.map((view) => [objectKey(view.reference), view]),
  );
  const tableTargets = new Set(document.targetTables.map(objectKey));
  const viewTargets = new Set(document.targetViews.map(objectKey));
  if (tablesByKey.size !== document.tables.length) {
    error('DUPLICATE_TABLE', 'document', 'Table identities must be unique.');
  }
  if (viewsByKey.size !== document.views.length) {
    error('DUPLICATE_VIEW', 'document', 'View identities must be unique.');
  }
  for (const [roots, definitions] of [
    [document.targetTables, tablesByKey],
    [document.targetViews, viewsByKey],
  ] as const) {
    for (const root of roots) {
      if (!definitions.has(objectKey(root))) {
        error(
          'MISSING_TARGET',
          qualifiedName(root),
          'Requested definition is absent.',
        );
      }
    }
  }

  const { expectedTables, directParents, reachableViews } =
    collectDependencyClosure(
      tableTargets,
      viewTargets,
      tablesByKey,
      viewsByKey,
    );
  for (const table of document.tables) {
    const key = objectKey(table.reference);
    const tableName = qualifiedName(table.reference);
    if (!expectedTables.has(key)) {
      error(
        'EXTRA_TABLE',
        tableName,
        'Table is outside the requested dependency closure.',
      );
    }
    let expectedRole: TableDefinition['role'] = 'view-dependency';
    if (tableTargets.has(key)) {
      expectedRole = 'target';
    } else if (directParents.has(key)) {
      expectedRole = 'direct-parent';
    }
    if (table.role !== expectedRole) {
      error(
        'ROLE_MISMATCH',
        tableName,
        'Table role disagrees with requested dependency closure.',
      );
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const view of document.views) {
    const key = objectKey(view.reference);
    const viewName = qualifiedName(view.reference);
    if (tablesByKey.has(key)) {
      error(
        'OBJECT_NAME_COLLISION',
        viewName,
        'Tables and views share a schema namespace.',
      );
    }
    if (!reachableViews.has(key)) {
      error(
        'EXTRA_VIEW',
        viewName,
        'View is outside the requested dependency closure.',
      );
    }
    if (view.role !== (viewTargets.has(key) ? 'target' : 'dependency')) {
      error('ROLE_MISMATCH', viewName, 'View role disagrees with target list.');
    }
    validateViewMetadata(view, error);

    const dependencies = new Set<string>();
    for (const edge of view.dependencies) {
      if (edge.databaseLink) {
        error(
          'REMOTE_VIEW_DEPENDENCY',
          viewName,
          'Remote view dependency is unsupported.',
        );
      } else if (edge.type === 'TABLE' || edge.type === 'VIEW') {
        const dependency = objectKey(edge.reference);
        const definitions = edge.type === 'TABLE' ? tablesByKey : viewsByKey;
        if (!definitions.has(dependency)) {
          error(
            'MISSING_VIEW_DEPENDENCY',
            viewName,
            `Required ${edge.type} ${qualifiedName(edge.reference)} is absent.`,
          );
        } else if (edge.type === 'VIEW') {
          dependencies.add(dependency);
        }
      } else if (['FUNCTION', 'PACKAGE', 'SYNONYM'].includes(edge.type)) {
        const resolution = resolveProvider(document, edge);
        if (
          resolution.error ||
          !resolution.provider ||
          !['TABLE', 'VIEW', 'FUNCTION', 'PACKAGE'].includes(
            resolution.provider.type,
          )
        )
          error(
            resolution.error ?? 'UNSUPPORTED_VIEW_DEPENDENCY',
            viewName,
            'View dependency has no supported provider.',
          );
      } else {
        error(
          'UNSUPPORTED_VIEW_DEPENDENCY',
          viewName,
          'Only TABLE and VIEW dependencies are supported.',
        );
      }
    }
    indegree.set(key, dependencies.size);
    for (const dependency of dependencies) {
      const dependentViews = dependents.get(dependency) ?? [];
      dependentViews.push(key);
      dependents.set(dependency, dependentViews);
    }
  }

  const orderedViews = orderViews(viewsByKey, indegree, dependents);
  if (orderedViews.length !== viewsByKey.size) {
    error(
      'VIEW_DEPENDENCY_CYCLE',
      'document',
      'View dependency graph contains a cycle.',
    );
  }
  const ordering = operationOrder(document);
  diagnostics.push(
    ...validatePrograms(document),
    ...validateSequences(document),
    ...validateProviders(document),
    ...objectGrants(document).diagnostics,
    ...ordering.diagnostics,
  );
  return {
    orderedOperations: ordering.operations,
    tablesByKey,
    viewsByKey,
    expectedTables,
    reachableViews,
    orderedViews,
    diagnostics,
  };
}

function collectDependencyClosure(
  tableTargets: ReadonlySet<string>,
  viewTargets: ReadonlySet<string>,
  tablesByKey: ReadonlyMap<string, TableDefinition>,
  viewsByKey: ReadonlyMap<string, ViewDefinition>,
) {
  const expectedTables = new Set(tableTargets);
  const directParents = new Set<string>();
  const reachableViews = new Set<string>();

  // Expand foreign keys only from explicitly requested tables, stopping after one hop.
  for (const key of tableTargets) {
    for (const constraint of tablesByKey.get(key)?.constraints ?? []) {
      if (constraint.kind === 'foreign-key') {
        const parent = objectKey(constraint.parentTable);
        expectedTables.add(parent);
        directParents.add(parent);
      }
    }
  }
  const queue = [...viewTargets];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    if (reachableViews.has(key)) {
      continue;
    }
    reachableViews.add(key);
    for (const edge of viewsByKey.get(key)?.dependencies ?? []) {
      if (edge.databaseLink) {
        continue;
      }
      if (edge.type === 'TABLE') {
        expectedTables.add(objectKey(edge.reference));
      }
      if (edge.type === 'VIEW') {
        queue.push(objectKey(edge.reference));
      }
    }
  }
  return { expectedTables, directParents, reachableViews };
}

function validateViewMetadata(view: ViewDefinition, error: ReportError): void {
  const viewName = qualifiedName(view.reference);
  if (view.status !== 'VALID') {
    error('INVALID_VIEW', viewName, 'Cannot reconstruct invalid view.');
  }
  if (new Set(view.columns).size !== view.columns.length) {
    error(
      'DUPLICATE_VIEW_COLUMN',
      viewName,
      'View column names must be unique.',
    );
  }
  for (const flag of [
    'editioning',
    'typed',
    'superview',
    'containerData',
  ] as const) {
    if (view[flag]) {
      error(
        'UNSUPPORTED_VIEW',
        viewName,
        `Unsupported specialized view flag: ${flag}.`,
      );
    }
  }
  if (view.readOnly && view.checkOption !== 'NONE') {
    error(
      'UNSUPPORTED_VIEW',
      viewName,
      'READ ONLY and CHECK OPTION cannot both be preserved.',
    );
  }
  if (view.collation && view.collation !== 'USING_NLS_COMP') {
    error(
      'UNSUPPORTED_COLLATION',
      viewName,
      `Explicit collation ${view.collation} requires a target policy.`,
    );
  }
  for (const feature of view.unsupportedFeatures) {
    error('UNSUPPORTED_VIEW', viewName, feature);
  }
}

function orderViews(
  viewsByKey: ReadonlyMap<string, ViewDefinition>,
  indegree: Map<string, number>,
  dependents: ReadonlyMap<string, readonly string[]>,
): ViewDefinition[] {
  // Sorted layers preserve deterministic ordering without rescanning pending nodes.
  let ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  const orderedViews: ViewDefinition[] = [];
  while (ready.length) {
    const next: string[] = [];
    for (const key of ready.sort(compareOrdinal)) {
      orderedViews.push(viewsByKey.get(key)!);
      for (const dependentView of dependents.get(key) ?? []) {
        const count = indegree.get(dependentView)! - 1;
        indegree.set(dependentView, count);
        if (count === 0) {
          next.push(dependentView);
        }
      }
    }
    ready = next;
  }
  return orderedViews;
}
