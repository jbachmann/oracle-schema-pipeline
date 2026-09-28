import { PlsqlSourceError } from './plsql.js';
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
  type ProgramDefinition,
  type ProcedureSelection,
  type ViewDependency,
  sourceDocumentSchema,
} from './model.js';

/** Read-only catalog metadata used to extract tables and optional views. */
export interface SourceCatalog {
  program?(reference: ObjectReference): Promise<ProgramDefinition>;
  oracleMaintained?(reference: ObjectReference, type: string): Promise<boolean>;
  prefetchPrograms?(references: ObjectReference[]): Promise<void>;
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

  const programs = await extractPrograms(
    catalog,
    selection,
    tables,
    views,
    prerequisites,
    progress,
  );

  // Check the assembled document's shape at the stage boundary. Semantic checks
  // against target policy belong to downstream validation.
  return sourceDocumentSchema.parse({
    formatVersion: 6,
    selectionVersion: selection.version,
    targetProcedures:
      selection.version === 3
        ? uniqueProcedureSelections(selection.procedures)
        : [],
    targetPackages:
      selection.version === 3 ? uniqueReferences(selection.packages) : [],
    programs,
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

export function uniqueProcedureSelections(
  references: ProcedureSelection[],
): ProcedureSelection[] {
  return [
    ...new Map(
      references.map((reference) => [
        JSON.stringify([
          reference.owner,
          reference.package ?? null,
          reference.name,
        ]),
        reference,
      ]),
    ).entries(),
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, reference]) => reference);
}

/** A second inclusion context can expand an already-read legacy object without
 * rereading it or promoting unrelated legacy prerequisites into export roots. */
async function extractPrograms(
  catalog: SourceCatalog,
  selection: ObjectSelection,
  tables: TableDefinition[],
  views: ViewDefinition[],
  prerequisites: Prerequisite[],
  progress: ExtractionProgress,
): Promise<ProgramDefinition[]> {
  if (
    selection.version !== 3 ||
    (!selection.procedures.length && !selection.packages.length)
  )
    return [];
  if (!catalog.program || !catalog.oracleMaintained)
    throw new Error('Catalog does not support program extraction.');
  const programRoots = uniqueReferences([
    ...selection.packages,
    ...selection.procedures.map((root) => ({
      owner: root.owner,
      name: root.package ?? root.name,
    })),
  ]);
  const rootKeys = new Set(programRoots.map(objectKey));
  const pending: ViewDependency[] = [
    ...selection.packages.map((reference) => ({
      reference,
      type: 'PACKAGE',
      databaseLink: null,
    })),
    ...selection.procedures.map((root) => ({
      reference: { owner: root.owner, name: root.package ?? root.name },
      type: root.package === undefined ? 'PROCEDURE' : 'PACKAGE',
      databaseLink: null,
    })),
  ];
  const programs = new Map<string, ProgramDefinition>();
  const tableMap = new Map(
    tables.map((table) => [objectKey(table.reference), table]),
  );
  const viewMap = new Map(
    views.map((view) => [objectKey(view.reference), view]),
  );
  const visited = new Set<string>();
  const preparedPrograms = new Set<string>();
  const types = new Map<string, string>();
  const supported = new Set([
    'TABLE',
    'VIEW',
    'PROCEDURE',
    'FUNCTION',
    'PACKAGE',
  ]);
  const follow = async (
    edges: (ViewDependency & { oracleMaintained?: boolean })[],
  ) => {
    for (const edge of edges) {
      if (edge.databaseLink) continue;
      const platform =
        edge.oracleMaintained ??
        (await catalog.oracleMaintained!(edge.reference, edge.type));
      edge.oracleMaintained = platform;
      if (!platform && supported.has(edge.type)) pending.push(edge);
    }
  };
  while (pending.length) {
    pending.sort((a, b) => {
      const left = JSON.stringify([
        a.reference.owner,
        a.reference.name,
        a.type,
      ]);
      const right = JSON.stringify([
        b.reference.owner,
        b.reference.name,
        b.type,
      ]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const toPrepare = uniqueReferences(
      pending
        .filter(
          (edge) =>
            ['PROCEDURE', 'FUNCTION', 'PACKAGE'].includes(edge.type) &&
            !visited.has(objectKey(edge.reference)) &&
            !preparedPrograms.has(objectKey(edge.reference)),
        )
        .map((edge) => edge.reference),
    );
    if (toPrepare.length && catalog.prefetchPrograms) {
      await catalog.prefetchPrograms(toPrepare);
      for (const reference of toPrepare)
        preparedPrograms.add(objectKey(reference));
    }
    const edge = pending.shift()!;
    const key = objectKey(edge.reference);
    if (types.has(key) && types.get(key) !== edge.type)
      throw new PlsqlSourceError('PLSQL_SOURCE_MISMATCH');
    types.set(key, edge.type);
    if (visited.has(key)) continue;
    visited.add(key);
    if (edge.type === 'TABLE') {
      let table = tableMap.get(key);
      if (!table) {
        table = await progress.measure(
          'object',
          () => catalog.table(edge.reference),
          { object: edge.reference },
        );
        table.role = 'program-dependency';
        tables.push(table);
        tableMap.set(key, table);
        prerequisites.push(...(await catalog.prerequisites(edge.reference)));
      }
      await follow([
        ...prerequisites.filter((item) => objectKey(item.requiredBy) === key),
        ...table.indexes.flatMap((index) => index.dependencies),
      ]);
    } else if (edge.type === 'VIEW') {
      let view = viewMap.get(key);
      if (!view) {
        if (!catalog.view || !catalog.viewDependencies)
          throw new Error('Catalog does not support views.');
        view = await progress.measure(
          'object',
          () => catalog.view!(edge.reference),
          { object: edge.reference },
        );
        view.dependencies = await catalog.viewDependencies(edge.reference);
        view.role = 'dependency';
        views.push(view);
        viewMap.set(key, view);
      }
      await follow(view.dependencies);
    } else {
      const program = await progress.measure(
        'object',
        () => catalog.program!(edge.reference),
        { object: edge.reference },
      );
      if (program.kind.toUpperCase() !== edge.type)
        throw new PlsqlSourceError('PLSQL_SOURCE_MISMATCH');
      if (program.oracleMaintained)
        throw new PlsqlSourceError('UNSUPPORTED_PLSQL');
      program.role = rootKeys.has(key) ? 'target' : 'dependency';
      programs.set(key, program);
      await follow(program.units.flatMap((unit) => unit.dependencies));
    }
  }
  for (const request of selection.procedures) {
    if (request.package === undefined) continue;
    const program = programs.get(
      objectKey({ owner: request.owner, name: request.package }),
    );
    if (
      program?.kind !== 'package' ||
      !program.publicProcedures.some((member) => member.name === request.name)
    )
      throw new PlsqlSourceError('PLSQL_MEMBER_NOT_FOUND');
  }
  tables.sort((a, b) =>
    objectKey(a.reference) < objectKey(b.reference)
      ? -1
      : objectKey(a.reference) > objectKey(b.reference)
        ? 1
        : 0,
  );
  views.sort((a, b) =>
    objectKey(a.reference) < objectKey(b.reference)
      ? -1
      : objectKey(a.reference) > objectKey(b.reference)
        ? 1
        : 0,
  );
  return [...programs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, program]) => program);
}
