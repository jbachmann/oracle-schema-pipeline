import { objectKey, uniqueReferences, type ForeignKeyDefinition, type ObjectReference, type Prerequisite,
  type SourceDocument, type TableDefinition, sourceDocumentSchema } from './model.js';

/** An interface keeps dependency selection testable without a live database. */
export interface SourceCatalog {
  databaseVersion(): Promise<string>;
  foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]>;
  table(reference: ObjectReference): Promise<TableDefinition>;
  prerequisites(table: ObjectReference): Promise<Prerequisite[]>;
}
export async function extractSource(catalog: SourceCatalog, requestedTables: ObjectReference[]): Promise<SourceDocument> {
  const targetTables = uniqueReferences(requestedTables);
  if (!targetTables.length) throw new Error('At least one target table is required.');
  const targetKeys = new Set(targetTables.map(objectKey));
  const directParents: ObjectReference[] = [];
  // Only original targets drive discovery. Parents never become new roots.
  for (const target of targetTables) {
    for (const foreignKey of await catalog.foreignKeys(target)) directParents.push(foreignKey.parentTable);
  }
  const tables: TableDefinition[] = [];
  const prerequisites: Prerequisite[] = [];
  for (const reference of uniqueReferences([...targetTables, ...directParents])) {
    const definition = await catalog.table(reference);
    definition.role = targetKeys.has(objectKey(reference)) ? 'target' : 'direct-parent';
    // Capture parent FKs as source facts, but do not fetch their parent tables.
    tables.push(definition);
    prerequisites.push(...await catalog.prerequisites(reference));
  }
  return sourceDocumentSchema.parse({
    formatVersion: 1, kind: 'source', dialect: 'oracle', sourceVersion: await catalog.databaseVersion(),
    extractedAt: new Date().toISOString(), targetTables, tables, prerequisites, diagnostics: [],
  });
}
