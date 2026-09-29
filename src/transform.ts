import { objectGrants, renderObjectGrant } from './object-grants.js';
import { sequenceStart } from './sequences.js';
/**
 * Converts extracted Oracle schema metadata into a reviewable Oracle 23 target
 * document without changing the source or connecting to a database. It attaches
 * the target policy, removes outgoing foreign keys from tables that were not
 * explicitly selected, and records those omissions and the destination storage
 * policy. The transformation report combines recorded changes with validation
 * results so callers can review issues before SQL generation.
 */
import { indexRequirements, renderIndexGrant } from './index-grants.js';
import {
  targetDocumentSchema,
  objectKey,
  qualifiedName,
  type ConstraintDefinition,
  type Diagnostic,
  type SourceDocument,
  type TableDefinition,
  type TargetDocument,
  type TargetPolicy,
} from './model.js';
import { validateTarget } from './validate.js';

/** Transform validated inputs without changing the source or accessing Oracle. */
export function transformSource(
  source: SourceDocument,
  policy: TargetPolicy,
): TargetDocument {
  const targetKeys = new Set(source.targetTables.map(objectKey));
  const results = source.tables.map((table) =>
    transformTable(table, targetKeys.has(objectKey(table.reference))),
  );
  // Return a reviewable target even when semantic errors block SQL generation.
  const target = targetDocumentSchema.parse({
    ...source,
    kind: 'target',
    targetVersion: '23',
    policy,
    tables: results.map((result) => result.table),
    diagnostics: [
      ...source.diagnostics,
      ...results.flatMap((result) => result.changes),
    ],
  });
  target.diagnostics.push(
    ...indexRequirements(target).grants.map((grant): Diagnostic => ({
      severity: 'change',
      code: 'INDEX_REQUIRED_GRANT',
      object: qualifiedName(grant.reference),
      message: renderIndexGrant(grant),
    })),
  );
  for (const sequence of target.sequences)
    target.diagnostics.push({
      severity: 'change',
      code: 'SEQUENCE_RESTART',
      object: qualifiedName(sequence.reference),
      message: `Restart at ${sequenceStart(sequence, target)} (${target.policy.sequenceStarts.some((item) => objectKey(item.reference) === objectKey(sequence.reference)) ? 'policy override' : 'direction bound'}); captured allocation state is not continued.`,
    });
  for (const grant of objectGrants(target).grants.filter(
    (item) => item.explicit,
  ))
    target.diagnostics.push({
      severity: 'change',
      code: 'EXPLICIT_OBJECT_GRANT',
      object: qualifiedName(grant.reference),
      message: renderObjectGrant(grant),
    });
  for (const unit of target.programUnits) {
    target.diagnostics.push({
      severity: 'change',
      code: 'PROGRAM_COMPILER_POLICY',
      object: qualifiedName(unit.reference) + ' ' + unit.type,
      message:
        'Compile with INTERPRETED, ENABLE:ALL warnings, and IDENTIFIERS:NONE; preserve captured semantic compiler settings.',
    });
    if (unit.type === 'PACKAGE')
      target.diagnostics.push({
        severity: 'change',
        code: 'INCLUDE_WHOLE_PACKAGE',
        object: qualifiedName(unit.reference),
        message: `Include complete specification${unit.packageBodyPresent ? ' and body' : ' (authoritatively body-less)'}. Selected members: ${
          [...target.targetProcedures, ...target.targetFunctions]
            .filter(
              (root) =>
                'package' in root &&
                root.owner === unit.reference.owner &&
                root.package === unit.reference.name,
            )
            .map((root) => root.name)
            .sort()
            .join(', ') || 'direct package selection'
        }.`,
      });
  }
  return target;
}

export function transformationReport(target: TargetDocument): Diagnostic[] {
  return [
    ...target.diagnostics.filter((item) => item.severity === 'change'),
    ...validateTarget(target),
  ];
}

function transformTable(
  table: TableDefinition,
  isTarget: boolean,
): { table: TableDefinition; changes: Diagnostic[] } {
  const tableName = qualifiedName(table.reference);
  const changes: Diagnostic[] = [];
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
    table: {
      ...table,
      role: isTarget ? 'target' : table.role,
      constraints,
    },
    changes,
  };
}
