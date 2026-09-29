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
  selectionSchema,
  type ProgramUnit,
  type SequenceDefinition,
  type SynonymDefinition,
  type NormalizedSelection,
} from './model.js';

/** Read-only relational catalog plus optional explicit program/supporting-object capabilities. */
export interface SourceCatalog {
  programUnits?(selection: NormalizedSelection): Promise<ProgramUnit[]>;
  sequences?(references: ObjectReference[]): Promise<SequenceDefinition[]>;
  synonyms?(references: ObjectReference[]): Promise<SynonymDefinition[]>;
  synonymResolution?(
    reference: ObjectReference,
  ): Promise<NonNullable<Prerequisite['synonymResolution']>>;
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
    extract(catalog, selectionSchema.parse(selection), progress),
  );
}

async function extract(
  catalog: SourceCatalog,
  selection: NormalizedSelection,
  progress: ExtractionProgress,
): Promise<SourceDocument> {
  const canonicalRoutines = (roots: NormalizedSelection['procedures']) =>
    [
      ...new Map(
        roots.map((root) => [
          JSON.stringify([
            root.owner,
            'package' in root ? root.package : null,
            root.name,
          ]),
          root,
        ]),
      ).entries(),
    ]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, root]) => root);
  selection = {
    ...selection,
    procedures: canonicalRoutines(selection.procedures),
    functions: canonicalRoutines(selection.functions),
    packages: uniqueReferences(selection.packages),
    sequences: uniqueReferences(selection.sequences),
    synonyms: uniqueReferences(selection.synonyms),
  };
  if (
    (selection.procedures.length ||
      selection.functions.length ||
      selection.packages.length) &&
    !catalog.programUnits
  )
    throw new Error('Catalog does not support selected programs.');
  if (selection.sequences.length && !catalog.sequences)
    throw new Error('Catalog does not support selected sequences.');
  if (selection.synonyms.length && !catalog.synonyms)
    throw new Error('Catalog does not support selected synonyms.');
  const programUnits =
    selection.procedures.length ||
    selection.functions.length ||
    selection.packages.length
      ? await catalog.programUnits!(selection)
      : [];
  const sequences = selection.sequences.length
    ? await catalog.sequences!(selection.sequences)
    : [];
  const synonyms = selection.synonyms.length
    ? await catalog.synonyms!(selection.synonyms)
    : [];
  const targetTables = uniqueReferences(selection.tables);
  const targetViews = uniqueReferences(selection.views);
  const targetTableKeys = new Set(targetTables.map(objectKey));
  const { views, tableReferences: viewTableReferences } = await extractViews(
    catalog,
    targetViews,
    progress,
  );

  const parents: ObjectReference[] = [];
  await catalog.prefetchForeignKeys?.(targetTables);
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
  const tableReferences = uniqueReferences([
    ...targetTables,
    ...parents,
    ...viewTableReferences,
  ]);
  await catalog.prefetchTables?.(tableReferences);
  for (const reference of tableReferences) {
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

  const included = new Set(
    [...tables, ...views, ...programUnits, ...sequences, ...synonyms].map(
      (item) => objectKey(item.reference),
    ),
  );
  for (const unit of programUnits)
    for (const edge of unit.dependencies) {
      if (!edge.oracleMaintained && !included.has(objectKey(edge.reference)))
        prerequisites.push({
          requiredBy: unit.reference,
          reference: edge.reference,
          type: edge.type,
          databaseLink: edge.databaseLink,
          synonymResolution: null,
        });
    }
  for (const view of views)
    for (const edge of view.dependencies)
      if (
        !['TABLE', 'VIEW'].includes(edge.type) &&
        !included.has(objectKey(edge.reference))
      )
        prerequisites.push({
          ...edge,
          requiredBy: view.reference,
          synonymResolution: null,
        });
  for (const synonym of synonyms)
    if (!included.has(objectKey(synonym.target)))
      prerequisites.push({
        requiredBy: synonym.reference,
        reference: synonym.target,
        type: synonym.targetType,
        databaseLink: synonym.databaseLink,
        synonymResolution: null,
      });
  for (const prerequisite of prerequisites)
    if (prerequisite.type === 'SYNONYM') {
      if (!catalog.synonymResolution)
        throw new Error(
          'Catalog does not support external synonym resolution.',
        );
      prerequisite.synonymResolution = await catalog.synonymResolution(
        prerequisite.reference,
      );
    }

  // Check the assembled document's shape at the stage boundary. Semantic checks
  // against target policy belong to downstream validation.
  return sourceDocumentSchema.parse({
    formatVersion: 6,
    targetProcedures: selection.procedures,
    targetFunctions: selection.functions,
    targetPackages: selection.packages,
    targetSequences: selection.sequences,
    targetSynonyms: selection.synonyms,
    programUnits,
    sequences,
    synonyms,
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
      } else if (edge.type === 'TABLE') {
        viewTableReferences.push(edge.reference);
      }
    }
  }

  return { views, tableReferences: viewTableReferences };
}
