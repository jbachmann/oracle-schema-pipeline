/**
 * Builds the pipeline's source document from read-only Oracle catalog metadata.
 * Extraction is the only core stage that accesses Oracle, through SourceCatalog;
 * transformation, validation, and SQL generation work from the captured document.
 * Tables are a strict explicit allowlist; selected views bring in transitive
 * local views and require their base tables to be explicitly selected. The document
 * records source facts and why each object was included so later stages can apply
 * target policy without querying or modifying the source database.
 */
import { ExtractionProgress } from './progress.js';
import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  uniqueReferences,
  type ForeignKeyDefinition,
  type ObjectReference,
  type Prerequisite,
  type SourceDocument,
  type TableDefinition,
  type ViewDefinition,
  type ObjectSelection,
  sourceDocumentSchema,
} from './model.js';

/** Read-only catalog metadata used to extract tables and optional views. */
export interface SourceCatalog {
  prefetchForeignKeys?(references: ObjectReference[]): Promise<void>;
  prefetchTables?(references: ObjectReference[]): Promise<void>;
  prefetchViews?(references: ObjectReference[]): Promise<void>;
  databaseVersion(): Promise<string>;
  foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]>;
  table(reference: ObjectReference): Promise<TableDefinition>;
  prerequisites(table: ObjectReference): Promise<Prerequisite[]>;
  view?(reference: ObjectReference): Promise<ViewDefinition>;
  viewDependencies?(
    reference: ObjectReference,
  ): Promise<ViewDefinition['dependencies']>;
}

/**
 * Extract selected objects and their supported dependencies into a schema-checked
 * source document. Optional progress reporting covers the run and object reads;
 * catalog or schema errors reject the extraction instead of returning a partial
 * document. Publishing the returned document is the caller's responsibility.
 */
export async function extractSource(
  catalog: SourceCatalog,
  selection: ObjectSelection,
  progress = new ExtractionProgress(),
): Promise<SourceDocument> {
  return progress.measure('extract', () =>
    extract(catalog, selection, progress),
  );
}

async function extract(
  catalog: SourceCatalog,
  selection: ObjectSelection,
  progress: ExtractionProgress,
): Promise<SourceDocument> {
  const targetTables = uniqueReferences(selection.tables);
  const targetViews = uniqueReferences(selection.views);
  const targetTableKeys = new Set(targetTables.map(objectKey));
  const { views } = await extractViews(
    catalog,
    targetViews,
    targetTableKeys,
    progress,
  );
  const tables: TableDefinition[] = [];
  const prerequisites: Prerequisite[] = [];
  const diagnostics: Diagnostic[] = [];
  const tableReferences = targetTables;
  await catalog.prefetchTables?.(tableReferences);
  for (const reference of tableReferences) {
    const table = await progress.measure(
      'object',
      () => catalog.table(reference),
      { object: reference },
    );
    const constraints = table.constraints.filter((constraint) => {
      if (
        constraint.kind !== 'foreign-key' ||
        targetTableKeys.has(objectKey(constraint.parentTable))
      )
        return true;
      diagnostics.push({
        severity: 'change',
        code: 'OMIT_UNSELECTED_FK',
        object: `${qualifiedName(reference)}/${constraint.name}`,
        message: `Omitted outgoing FK to ${qualifiedName(constraint.parentTable)} because the parent table is not explicitly selected.`,
      });
      return false;
    });
    tables.push({ ...table, role: 'target', constraints });
    prerequisites.push(...(await catalog.prerequisites(reference)));
  }

  // Check the assembled document's shape at the stage boundary. Semantic checks
  // against target policy belong to downstream validation.
  return sourceDocumentSchema.parse({
    formatVersion: 6,
    kind: 'source',
    dialect: 'oracle',
    sourceVersion: await catalog.databaseVersion(),
    extractedAt: new Date().toISOString(),
    targetTables,
    targetViews,
    tables,
    views,
    prerequisites,
    diagnostics,
  });
}

/** Collect local views once each, requiring explicit local base tables. */
async function extractViews(
  catalog: SourceCatalog,
  targetViews: ObjectReference[],
  targetTableKeys: ReadonlySet<string>,
  progress: ExtractionProgress,
): Promise<{ views: ViewDefinition[] }> {
  const views: ViewDefinition[] = [];
  if (targetViews.length === 0) {
    return { views };
  }
  if (!catalog.view || !catalog.viewDependencies) {
    throw new Error('Catalog does not support views.');
  }
  const readView = catalog.view.bind(catalog);
  const readViewDependencies = catalog.viewDependencies.bind(catalog);

  // Walk views transitively and check their explicit base tables. Generation
  // orders views by dependency downstream, after recreating the base tables.
  const targetViewKeys = new Set(targetViews.map(objectKey));
  const pendingViews = [...targetViews];
  const visitedViewKeys = new Set<string>();
  const preparedViewKeys = new Set<string>();
  while (pendingViews.length) {
    // Stable read order is independent of catalog dependency ordering. The
    // visited set also terminates cycles, which downstream validation reports.
    pendingViews.sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
    if (
      catalog.prefetchViews &&
      !preparedViewKeys.has(objectKey(pendingViews[0]))
    ) {
      const references = uniqueReferences(pendingViews).filter(
        (reference) =>
          !visitedViewKeys.has(objectKey(reference)) &&
          !preparedViewKeys.has(objectKey(reference)),
      );
      await catalog.prefetchViews(references);
      for (const reference of references)
        preparedViewKeys.add(objectKey(reference));
    }
    const reference = pendingViews.shift();
    if (reference === undefined) {
      break;
    }
    const key = objectKey(reference);
    if (visitedViewKeys.has(key)) {
      continue;
    }
    visitedViewKeys.add(key);

    const definition = await progress.measure(
      'object',
      () => readView(reference),
      {
        object: reference,
      },
    );
    const view: ViewDefinition = {
      ...definition,
      dependencies: await readViewDependencies(reference),
      role: targetViewKeys.has(key) ? 'target' : 'dependency',
    };
    views.push(view);
    for (const edge of view.dependencies) {
      // Keep remote edges in the metadata for downstream checks, but never
      // follow a database link to extract objects from another database.
      if (edge.databaseLink) {
        continue;
      }
      if (edge.type === 'VIEW') {
        pendingViews.push(edge.reference);
      } else if (
        edge.type === 'TABLE' &&
        !targetTableKeys.has(objectKey(edge.reference))
      ) {
        throw Object.assign(
          new Error(
            `View ${qualifiedName(reference)} requires unselected table ${qualifiedName(edge.reference)}; add ${JSON.stringify(edge.reference)} to the selection tables list.`,
          ),
          { code: 'UNSELECTED_VIEW_TABLE' },
        );
      }
    }
  }

  return { views };
}
