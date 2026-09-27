import {
  sourceDocumentSchema,
  targetDocumentSchema,
  policySchema,
  objectKey,
  qualifiedName,
  type ConstraintDefinition,
  type Diagnostic,
  type TableDefinition,
  type TargetDocument,
} from './model.js';
import { validateTarget } from './validate.js';

/** Pure transformation: it never changes the source object or accesses Oracle. */
export function transformSource(
  sourceInput: unknown,
  policyInput: unknown = {},
): TargetDocument {
  const source = sourceDocumentSchema.parse(sourceInput);
  const policy = policySchema.parse(policyInput);
  const targetKeys = new Set(source.targetTables.map(objectKey));
  const changes: Diagnostic[] = [];
  const tables = source.tables.map((table): TableDefinition => {
    const tableName = qualifiedName(table.reference);
    const isTarget = targetKeys.has(objectKey(table.reference));
    const constraints: ConstraintDefinition[] = [];
    for (const constraint of table.constraints) {
      if (!isTarget && constraint.kind === 'foreign-key') {
        changes.push({
          severity: 'change',
          code: 'OMIT_PARENT_FK',
          object: `${tableName}/${constraint.name}`,
          message: `Omitted outgoing FK to ${qualifiedName(constraint.parentTable)} because this table is a parent-only inclusion.`,
        });
      } else {
        constraints.push(constraint);
      }
    }
    changes.push({
      severity: 'change',
      code: 'TARGET_STORAGE',
      object: tableName,
      message:
        'Use deferred allocation and destination default storage; omit source tablespace, compression and allocation settings.',
    });
    return {
      ...table,
      role: isTarget ? 'target' : table.role,
      constraints,
    };
  });
  // Return a reviewable target even when semantic errors block SQL generation.
  return targetDocumentSchema.parse({
    ...source,
    kind: 'target',
    targetVersion: '23',
    policy,
    tables,
    diagnostics: [...source.diagnostics, ...changes],
  });
}

export function transformationReport(target: TargetDocument): Diagnostic[] {
  return [
    ...target.diagnostics.filter((item) => item.severity === 'change'),
    ...validateTarget(target),
  ];
}
