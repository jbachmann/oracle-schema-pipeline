import { sourceDocumentSchema, targetDocumentSchema, policySchema, objectKey, qualifiedName,
  type Diagnostic, type TargetDocument } from './model.js';
import { validateTarget } from './validate.js';

/** Pure transformation: it never changes the source object or accesses Oracle. */
export function transformSource(sourceInput: unknown, policyInput: unknown = {}): TargetDocument {
  const source = sourceDocumentSchema.parse(sourceInput);
  const policy = policySchema.parse(policyInput);
  const targetKeys = new Set(source.targetTables.map(objectKey));
  const changes: Diagnostic[] = [];
  const tables = source.tables.map(table => {
    const isTarget = targetKeys.has(objectKey(table.reference));
    const constraints = table.constraints.filter(constraint => {
      if (!isTarget && constraint.kind === 'foreign-key') {
        changes.push({ severity: 'change', code: 'OMIT_PARENT_FK', object: `${qualifiedName(table.reference)}/${constraint.name}`,
          message: `Omitted outgoing FK to ${qualifiedName(constraint.parentTable)} because this table is a parent-only inclusion.` });
        return false;
      }
      return true;
    });
    changes.push({ severity: 'change', code: 'TARGET_STORAGE', object: qualifiedName(table.reference),
      message: 'Use deferred allocation and destination default storage; omit source tablespace, compression and allocation settings.' });
    return { ...table, role: isTarget ? 'target' as const : table.role, constraints };
  });
  const target = targetDocumentSchema.parse({ ...source, kind: 'target', targetVersion: '23', policy, tables,
    diagnostics: [...source.diagnostics, ...changes] });
  // Persist a reviewable target even when unsupported source features block SQL.
  // Revalidation computes errors afresh; source diagnostics remain authoritative.
  return target;
}
export function transformationReport(target: TargetDocument): Diagnostic[] {
  return [...target.diagnostics.filter(item => item.severity === 'change'), ...validateTarget(target)];
}
