import { renderIdentity } from './identity.js';
import { targetDocumentSchema, objectKey, qualifiedName, type Diagnostic, type TargetDocument } from './model.js';
import { renderDataType } from './types.js';
import { renderComment } from './comments.js';

/** Validate semantic references in addition to the JSON document's shape. */
export function validateTarget(input: unknown): Diagnostic[] {
  const document = targetDocumentSchema.parse(input);
  const diagnostics: Diagnostic[] = [...document.diagnostics.filter(item => item.severity !== 'change')];
  const error = (code: string, object: string, message: string): void => { diagnostics.push({ severity: 'error', code, object, message }); };
  const tablesByKey = new Map(document.tables.map(table => [objectKey(table.reference), table]));
  const targetKeys = new Set(document.targetTables.map(objectKey));
  const expectedTables = new Set(targetKeys);
  const constraintNames = new Set<string>(), indexNames = new Set<string>();
  if (tablesByKey.size !== document.tables.length) error('DUPLICATE_TABLE', 'document', 'Table identities must be unique.');
  for (const root of document.targetTables) if (!tablesByKey.has(objectKey(root))) error('MISSING_TARGET', qualifiedName(root), 'Requested target definition is absent.');
  for (const table of document.tables) {
    const tableName = qualifiedName(table.reference);
    const isTarget = targetKeys.has(objectKey(table.reference));
    if (table.role === 'target' !== isTarget) error('ROLE_MISMATCH', tableName, 'Table role disagrees with the original target list.');
    for (const feature of table.unsupportedFeatures) error('UNSUPPORTED_FEATURE', tableName, feature);
    if (table.comment !== null) {
      try { renderComment(table.reference, null, table.comment); }
      catch (reason) { error('UNRENDERABLE_TABLE_COMMENT', tableName, String(reason)); }
    }
    const columnNames = new Set(table.columns.map(column => column.name));
    if (columnNames.size !== table.columns.length) error('DUPLICATE_COLUMN', tableName, 'Column names must be unique.');
    if (new Set(table.columns.map(column => column.position)).size !== table.columns.length) error('DUPLICATE_POSITION', tableName, 'Column positions must be unique.');
    const indexesByKey = new Map(table.indexes.map(index => [objectKey(index.reference), index]));
    for (const column of table.columns) {
      if (table.constraints.filter(constraint => constraint.kind === 'not-null' && constraint.column === column.name).length > 1) error('DUPLICATE_NOT_NULL', tableName, `Multiple NOT NULL constraints on ${column.name} need manual review.`);
      const columnName = `${tableName}.${column.name}`;
      if (column.comment !== null) {
        try { renderComment(table.reference, column.name, column.comment); }
        catch (reason) { error('UNRENDERABLE_COLUMN_COMMENT', columnName, String(reason)); }
      }
      try { renderDataType(column, document.policy); } catch (reason) { error('UNSUPPORTED_TYPE', columnName, String(reason)); }
      if (column.identity) {
        try { renderIdentity(column); } catch (reason) { error('UNSUPPORTED_IDENTITY', columnName, String(reason)); }
      }
      if (column.collation && column.collation !== 'USING_NLS_COMP') error('UNSUPPORTED_COLLATION', columnName, `Explicit collation ${column.collation} requires a target policy.`);
      if (column.virtual && (!column.defaultExpression || column.defaultOnNull || column.identity)) error('INVALID_VIRTUAL_COLUMN', columnName, 'Virtual columns need an expression and cannot have identity/default-on-null settings.');
      if (column.defaultOnNull && !column.defaultExpression) error('MISSING_DEFAULT', columnName, 'DEFAULT ON NULL needs an expression.');
      if (!column.nullable && !column.identity && !column.defaultOnNull) {
        const enforced = table.constraints.some(constraint => constraint.state.enabled &&
          ((constraint.kind === 'not-null' && constraint.column === column.name) ||
           (constraint.kind === 'primary-key' && constraint.columns.includes(column.name))));
        if (!enforced) error('MISSING_NULLABILITY_CONSTRAINT', columnName, 'Nonnullable source column has no modeled PK or NOT NULL constraint.');
      }
    }
    for (const index of table.indexes) {
      const indexName = qualifiedName(index.reference), identity = objectKey(index.reference);
      if (indexNames.has(identity)) error('DUPLICATE_INDEX', indexName, 'Index names must be unique within their schema.');
      indexNames.add(identity);
      if (index.reference.owner !== table.reference.owner) error('CROSS_OWNER_INDEX', indexName, 'Cross-owner index recreation needs a dedicated policy.');
      if (!['NORMAL', 'NORMAL/REV', 'BITMAP', 'FUNCTION-BASED NORMAL', 'FUNCTION-BASED BITMAP'].includes(index.type) || index.partitioned) error('UNSUPPORTED_INDEX', indexName, 'Only nonpartitioned conventional and function-based indexes are implemented.');
      if (index.type === 'NORMAL/REV' && index.keys.some(key => key.expression || key.direction !== 'ASC')) error('UNSUPPORTED_REVERSE_KEY', indexName, 'Reverse-key indexes must use ordinary ascending columns.');
      if (index.status !== 'VALID') error('INDEX_STATE', indexName, `Cannot preserve index status ${index.status}.`);
      if (index.type.includes('BITMAP') && index.unique) error('INVALID_INDEX', indexName, 'A bitmap index cannot be UNIQUE.');
      for (const key of index.keys) {
        if ((key.column === null) === (key.expression === null)) error('INVALID_INDEX_KEY', indexName, 'Each key must specify exactly one column or SQL expression.');
        if (key.column && !columnNames.has(key.column)) error('MISSING_INDEX_COLUMN', indexName, `Column ${key.column} is absent.`);
        if (key.expression && /\bSYS_OP_/i.test(key.expression)) error('INTERNAL_INDEX_EXPRESSION', indexName, 'Oracle internal index expressions require normalization before rendering.');
      }
    }
    if (table.constraints.filter(constraint => constraint.kind === 'primary-key').length > 1) error('MULTIPLE_PRIMARY_KEYS', tableName, 'At most one primary key is allowed.');
    for (const constraint of table.constraints) {
      const constraintName = `${tableName}/${constraint.name}`;
      const constraintKey = JSON.stringify([table.reference.owner, constraint.name]);
      if (constraintNames.has(constraintKey)) error('DUPLICATE_CONSTRAINT', constraintName, 'Constraint names must be unique within a schema.');
      constraintNames.add(constraintKey);
      if (!constraint.state.deferrable && constraint.state.initiallyDeferred) error('INVALID_STATE', constraintName, 'A nondeferrable constraint cannot start deferred.');
      const referencedColumns = constraint.kind === 'not-null' ? [constraint.column] :
        constraint.kind === 'foreign-key' ? constraint.columnPairs.map(pair => pair.childColumn) :
        constraint.kind === 'check' ? [] : constraint.columns;
      for (const column of referencedColumns) if (!columnNames.has(column)) error('MISSING_CONSTRAINT_COLUMN', constraintName, `Column ${column} is absent.`);
      if (new Set(referencedColumns).size !== referencedColumns.length) error('DUPLICATE_KEY_COLUMN', constraintName, 'Constraint columns must not repeat.');
      if ((constraint.kind === 'not-null' || constraint.kind === 'check') && constraint.state.deferrable) error('UNSUPPORTED_DEFERRAL', constraintName, 'Deferrable check/not-null rendering is unsupported.');
      if (constraint.kind === 'primary-key' || constraint.kind === 'unique') {
        if (!constraint.state.enabled) error('DISABLED_CANDIDATE_KEY', constraintName, 'Disabled PK/UK index lifecycle needs a specialized renderer.');
        if (constraint.backingIndex) {
          const index = indexesByKey.get(objectKey(constraint.backingIndex));
          if (!index) error('MISSING_BACKING_INDEX', constraintName, 'The supporting index is not defined on this table.');
          else {
            const exactColumns = index.keys.map(key => key.column);
            if (JSON.stringify(exactColumns) !== JSON.stringify(constraint.columns) || index.keys.some(key => key.expression || key.direction !== 'ASC') || index.type !== 'NORMAL') {
              error('UNSUPPORTED_BACKING_INDEX', constraintName, 'Version 1 requires an ordinary ascending backing index with exactly the constraint columns in order.');
            }
            if (constraint.state.deferrable && index.unique) error('INVALID_DEFERRABLE_INDEX', constraintName, 'Deferrable PK/UK needs a nonunique backing index.');
          }
        }
      }
      if (constraint.kind === 'foreign-key') {
        if (!isTarget) error('PARENT_FK_RETAINED', constraintName, 'Parent-only outgoing FKs must be removed by transformation.');
        expectedTables.add(objectKey(constraint.parentTable));
        const parent = tablesByKey.get(objectKey(constraint.parentTable));
        if (!parent) { error('MISSING_PARENT', constraintName, 'Referenced table is not in the target model.'); continue; }
        const candidate = parent.constraints.find(candidate => candidate.name === constraint.parentConstraint.name &&
          constraint.parentConstraint.owner === parent.reference.owner && ['primary-key', 'unique'].includes(candidate.kind));
        if (!candidate || !(candidate.kind === 'primary-key' || candidate.kind === 'unique') ||
            JSON.stringify(candidate.columns) !== JSON.stringify(constraint.columnPairs.map(pair => pair.parentColumn))) {
          error('MISSING_PARENT_KEY', constraintName, 'Referenced ordered PK/UK does not match the FK column pairs.');
        }
      }
    }
  }
    {
    const viewsByKey = new Map(document.views.map(view => [objectKey(view.reference), view]));
    const viewTargets = new Set(document.targetViews.map(objectKey));
    if (viewsByKey.size !== document.views.length) error("DUPLICATE_VIEW", "document", "View identities must be unique.");
    for (const root of document.targetViews) if (!viewsByKey.has(objectKey(root))) error("MISSING_TARGET", qualifiedName(root), "Requested view definition is absent.");
    for (const view of document.views) {
      const name = qualifiedName(view.reference);
      if (view.role !== (viewTargets.has(objectKey(view.reference)) ? "target" : "dependency")) error("ROLE_MISMATCH", name, "View role disagrees with target list.");
      if (view.status !== "VALID") error("INVALID_VIEW", name, "Cannot reconstruct invalid view.");
      for (const feature of view.unsupportedFeatures) error("UNSUPPORTED_VIEW", name, feature);
      for (const edge of view.dependencies) {
        if (edge.databaseLink) error("REMOTE_VIEW_DEPENDENCY", name, "Remote view dependency is unsupported.");
        else if (edge.type === "TABLE") { expectedTables.add(objectKey(edge.reference)); if (!tablesByKey.has(objectKey(edge.reference))) error("MISSING_VIEW_DEPENDENCY", name, "Required table is absent."); }
        else if (edge.type === "VIEW") { if (!viewsByKey.has(objectKey(edge.reference))) error("MISSING_VIEW_DEPENDENCY", name, "Required view is absent."); }
        else error("UNSUPPORTED_VIEW_DEPENDENCY", name, "Only TABLE and VIEW dependencies are supported.");
      }
    }
    const pending = new Map(document.views.map(view => [objectKey(view.reference), new Set(view.dependencies.filter(edge => edge.type === "VIEW" && !edge.databaseLink).map(edge => objectKey(edge.reference)))]));
    while (pending.size) { const ready = [...pending].filter(([, deps]) => [...deps].every(key => !pending.has(key))); if (!ready.length) { error("VIEW_DEPENDENCY_CYCLE", "document", "View dependency graph contains a cycle."); break; } for (const [key] of ready) pending.delete(key); }
  }
  for (const table of document.tables) if (!expectedTables.has(objectKey(table.reference))) error('EXTRA_TABLE', qualifiedName(table.reference), 'Table is outside the requested dependency closure.');
  for (const prerequisite of document.prerequisites) {
    const allowed = document.policy.externalPrerequisites.some(item => item.type === prerequisite.type && objectKey(item.reference) === objectKey(prerequisite.reference));
    if (prerequisite.databaseLink) error('REMOTE_PREREQUISITE', qualifiedName(prerequisite.requiredBy), 'Remote dependencies are unsupported.');
    else if (!allowed) error('UNACKNOWLEDGED_PREREQUISITE', qualifiedName(prerequisite.requiredBy), `Provision and acknowledge ${prerequisite.type} ${qualifiedName(prerequisite.reference)} in the target policy.`);
  }
  if (document.policy.createSchemas && document.policy.externalPrerequisites.length) error('PREREQUISITE_SETUP', 'policy', 'Use createSchemas=false when prerequisite objects are provisioned in advance.');
  // Deduplicate diagnostics so repeated validation remains stable.
  return [...new Map(diagnostics.map(item => [JSON.stringify(item), item])).values()];
}
export function assertValidTarget(input: unknown): TargetDocument {
  const document = targetDocumentSchema.parse(input);
  const errors = validateTarget(document).filter(item => item.severity === 'error');
  if (errors.length) throw new Error(errors.map(item => `${item.code}: ${item.object}: ${item.message}`).join('\n'));
  return document;
}
