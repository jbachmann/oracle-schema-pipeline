/**
 * Builds the pipeline's source document from read-only Oracle catalog metadata.
 * Extraction is the only core stage that accesses Oracle, through SourceCatalog;
 * transformation, validation, and SQL generation work from the captured document.
 * Selected tables bring in their direct foreign-key parents, while selected views
 * bring in transitive local view dependencies and their base tables. The document
 * records source facts and why each object was included so later stages can apply
 * target policy without querying or modifying the source database.
 */
import { ExtractionProgress } from './progress.js';
import {
  objectKey,
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
  const { views, tableReferences: viewTableReferences } = await extractViews(
    catalog,
    targetViews,
    progress,
  );

  const parents: ObjectReference[] = [];
  // Only direct FK parents are included. Their own outgoing FKs are later
  // removed by transformation, keeping the dependency closure intentionally
  // bounded instead of recursively cloning the surrounding schema.
  for (const target of targetTables) {
    for (const fk of await catalog.foreignKeys(target)) {
      parents.push(fk.parentTable);
    }
  }

  const parentKeys = new Set(parents.map(objectKey));
  const tables: TableDefinition[] = [];
  const prerequisites: Prerequisite[] = [];
  for (const reference of uniqueReferences([
    ...targetTables,
    ...parents,
    ...viewTableReferences,
  ])) {
    const table = await progress.measure(
      'object',
      () => catalog.table(reference),
      { object: reference },
    );
    const key = objectKey(reference);
    // An object can be reached through several paths. Explicit selection takes
    // precedence because transformation retains outgoing FKs only for targets.
    if (targetTableKeys.has(key)) {
      table.role = 'target';
    } else if (parentKeys.has(key)) {
      table.role = 'direct-parent';
    } else {
      table.role = 'view-dependency';
    }
    tables.push(table);
    prerequisites.push(...(await catalog.prerequisites(reference)));
  }

  // Check the assembled document's shape at the stage boundary. Semantic checks
  // against target policy belong to downstream validation.
  return sourceDocumentSchema.parse({
    formatVersion: 5,
    kind: 'source',
    dialect: 'oracle',
    sourceVersion: await catalog.databaseVersion(),
    extractedAt: new Date().toISOString(),
    targetTables,
    targetViews,
    tables,
    views,
    prerequisites,
    diagnostics: [],
  });
}

/** Collect local views once each and return table references for table extraction. */
async function extractViews(
  catalog: SourceCatalog,
  targetViews: ObjectReference[],
  progress: ExtractionProgress,
): Promise<{ views: ViewDefinition[]; tableReferences: ObjectReference[] }> {
  const views: ViewDefinition[] = [];
  const viewTableReferences: ObjectReference[] = [];
  if (targetViews.length === 0) {
    return { views, tableReferences: viewTableReferences };
  }
  if (!catalog.view || !catalog.viewDependencies) {
    throw new Error('Catalog does not support views.');
  }
  const readView = catalog.view.bind(catalog);
  const readViewDependencies = catalog.viewDependencies.bind(catalog);

  // Walk views transitively and collect their base tables separately. Generation
  // orders views by dependency downstream, after recreating the base tables.
  const targetViewKeys = new Set(targetViews.map(objectKey));
  const pendingViews = [...targetViews];
  const visitedViewKeys = new Set<string>();
  while (pendingViews.length) {
    // Stable read order is independent of catalog dependency ordering. The
    // visited set also terminates cycles, which downstream validation reports.
    pendingViews.sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
    const reference = pendingViews.shift();
    if (reference === undefined) {
      break;
    }
    const key = objectKey(reference);
    if (visitedViewKeys.has(key)) {
      continue;
    }
    visitedViewKeys.add(key);

    const view = await progress.measure('object', () => readView(reference), {
      object: reference,
    });
    view.dependencies = await readViewDependencies(reference);
    view.role = targetViewKeys.has(key) ? 'target' : 'dependency';
    views.push(view);
    for (const edge of view.dependencies) {
      // Keep remote edges in the metadata for downstream checks, but never
      // follow a database link to extract objects from another database.
      if (edge.databaseLink) {
        continue;
      }
      if (edge.type === 'VIEW') {
        pendingViews.push(edge.reference);
      } else {
        viewTableReferences.push(edge.reference);
      }
    }
  }

  return { views, tableReferences: viewTableReferences };
}
