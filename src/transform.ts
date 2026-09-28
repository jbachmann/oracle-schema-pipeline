import { analyzePrograms } from './program-semantics.js';
import { programRequirements, renderProgramGrant } from './program-grants.js';
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
  target.diagnostics.push(
    ...target.programs.map((program): Diagnostic => ({
      severity: 'change',
      code:
        program.kind === 'package' && program.role === 'target'
          ? 'PLSQL_PACKAGE_INCLUDED'
          : 'PLSQL_DEPENDENCY_INCLUDED',
      object: qualifiedName(program.reference),
      message:
        program.kind === 'package'
          ? 'Included the whole package specification and available body, including all members and initialization.'
          : 'Included program and its captured supported dependency closure.',
    })),
    ...programRequirements(target).grants.map((grant): Diagnostic => ({
      severity: 'change',
      code: 'PLSQL_REQUIRED_GRANT_ADDED',
      object: qualifiedName(grant.reference),
      message: renderProgramGrant(grant),
    })),
  );
  const programReachability = analyzePrograms(target);
  target.diagnostics.push(
    ...[
      ...target.tables.filter((table) => table.role === 'program-dependency'),
      ...target.views.filter(
        (view) =>
          view.role === 'dependency' &&
          programReachability.reachableViews.has(objectKey(view.reference)),
      ),
    ].map((item): Diagnostic => ({
      severity: 'change',
      code: 'PLSQL_DEPENDENCY_INCLUDED',
      object: qualifiedName(item.reference),
      message:
        'Included a table or view reached through recorded program dependencies.',
    })),
  );
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
        message: `Omitted outgoing FK to ${qualifiedName(constraint.parentTable)} because this table was included only as a dependency.`,
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
