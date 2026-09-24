import { objectKey, uniqueReferences, type ForeignKeyDefinition, type ObjectReference, type Prerequisite,
  type SourceDocument, type TableDefinition, type ViewDefinition, type ObjectSelection, sourceDocumentSchema } from './model.js';

/** An interface keeps dependency selection testable without a live database. */
export interface SourceCatalog {
  databaseVersion(): Promise<string>;
  foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]>;
  table(reference: ObjectReference): Promise<TableDefinition>;
  prerequisites(table: ObjectReference): Promise<Prerequisite[]>;
  view?(reference: ObjectReference): Promise<ViewDefinition>;
  viewDependencies?(reference: ObjectReference): Promise<ViewDefinition['dependencies']>;
}
export async function extractSource(catalog: SourceCatalog, selection: ObjectSelection): Promise<SourceDocument> {
  if (selection.views.length && (!catalog.view || !catalog.viewDependencies)) throw new Error('Catalog does not support views.');
  const targetTables = uniqueReferences(selection.tables), targetViews = uniqueReferences(selection.views);
  const tableTargets = new Set(targetTables.map(objectKey)), viewTargets = new Set(targetViews.map(objectKey));
  const queue = [...targetViews], seen = new Set<string>(), views: ViewDefinition[] = [], viewTables: ObjectReference[] = [];
  while (queue.length) {
    queue.sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
    const reference = queue.shift()!, key = objectKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    const view = await catalog.view!(reference);
    view.dependencies = await catalog.viewDependencies!(reference);
    view.role = viewTargets.has(key) ? 'target' : 'dependency';
    views.push(view);
    for (const edge of view.dependencies) if (!edge.databaseLink) {
      if (edge.type === 'VIEW') queue.push(edge.reference); else viewTables.push(edge.reference);
    }
  }
  const parents: ObjectReference[] = [];
  for (const target of targetTables) for (const fk of await catalog.foreignKeys(target)) parents.push(fk.parentTable);
  const parentKeys = new Set(parents.map(objectKey)), tables: TableDefinition[] = [], prerequisites: Prerequisite[] = [];
  for (const reference of uniqueReferences([...targetTables, ...parents, ...viewTables])) {
    const table = await catalog.table(reference), key = objectKey(reference);
    table.role = tableTargets.has(key) ? 'target' : parentKeys.has(key) ? 'direct-parent' : 'view-dependency';
    tables.push(table); prerequisites.push(...await catalog.prerequisites(reference));
  }
  return sourceDocumentSchema.parse({ formatVersion: 3, kind: 'source', dialect: 'oracle', sourceVersion: await catalog.databaseVersion(),
    extractedAt: new Date().toISOString(), targetTables, targetViews, tables, views, prerequisites, diagnostics: [] });
}
