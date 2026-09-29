import { renderSynonym, verifySynonymsSql } from './synonyms.js';
import { creationOrder } from './creation-order.js';
import { compilePrograms } from './program-sql.js';
import { renderSequence } from './sequences.js';
import { isIncluded, resolveDependency } from './dependencies.js';
/**
 * Coordinates SQL preparation from parsed target metadata and semantic analysis.
 * Orders the reconstruction phases, sorts objects deterministically, and places
 * deduplicated grants before the indexes, foreign keys, and views that need them.
 * Object rendering lives in ddl.ts; sql-preparation.ts collects SQL and diagnostics.
 *
 * validate.ts runs preparation to find rendering errors alongside metadata
 * errors. Once validation succeeds, generate.ts joins the prepared operations
 * into the output script. Preparation is entirely offline and never executes
 * SQL or authorizes publication on its own.
 */
import { schemaOwners } from './schema-owners.js';
import { indexRequirements, renderIndexGrant } from './index-grants.js';
import { compareOrdinal, type analyzeTarget } from './semantic.js';
import { renderComment } from './comments.js';
import {
  renderTable,
  renderIndex,
  renderLocalConstraint,
  renderForeignKey,
  renderView,
} from './ddl.js';
import {
  quoteIdentifier,
  qualifiedName,
  objectKey,
  type TableDefinition,
  type TargetDocument,
  type ViewDefinition,
} from './model.js';
import {
  createSqlPreparation,
  type SqlCollector,
  type SqlPreparation,
} from './sql-preparation.js';

function orderedColumns(table: TableDefinition) {
  return [...table.columns].sort(
    (left, right) => left.position - right.position,
  );
}

function orderedConstraints(table: TableDefinition) {
  return [...table.constraints].sort((left, right) =>
    compareOrdinal(left.name, right.name),
  );
}

function emitPreamble(document: TargetDocument, { emit }: SqlCollector): void {
  emit(
    'document',
    `-- Generated from oracle-schema-pipeline format ${document.formatVersion}. Includes metadata-derived program DDL.`,
    'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
    'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
    'SET DEFINE OFF',
    'SET SQLBLANKLINES ON',
    'SET ECHO ON',
    'ALTER SESSION SET DEFERRED_SEGMENT_CREATION=TRUE;',
  );
}

function emitSchemas(document: TargetDocument, { emit }: SqlCollector): void {
  if (!document.policy.createSchemas) {
    return;
  }
  const tablespace = quoteIdentifier(document.policy.defaultTablespace);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  for (const owner of schemaOwners(document)) {
    const create = `CREATE USER ${quoteIdentifier(owner)} NO AUTHENTICATION DEFAULT TABLESPACE ${tablespace} QUOTA UNLIMITED ON ${tablespace}`;
    // Native IF NOT EXISTS also skips conflicting roles on the pinned Oracle
    // image. Check users explicitly and let every creation error remain fatal.
    emit(
      quoteIdentifier(owner),
      `DECLARE\n  n NUMBER;\nBEGIN\n  SELECT COUNT(*) INTO n FROM ALL_USERS WHERE USERNAME = ${literal(owner)};\n  IF n = 0 THEN\n    EXECUTE IMMEDIATE ${literal(create)};\n  END IF;\nEND;\n/`,
    );
  }
}

function emitTables(
  tables: TableDefinition[],
  policy: TargetDocument['policy'],
  { emit, attemptRender }: SqlCollector,
): void {
  emit('document', '-- Phase 1: all tables, without foreign keys.');
  for (const table of tables) {
    emit(
      qualifiedName(table.reference),
      renderTable(table, orderedColumns(table), policy, attemptRender),
    );
  }
}

function emitComments(
  tables: TableDefinition[],
  { emit, attemptRender }: SqlCollector,
): void {
  emit('document', '-- Phase 2: table and column comments.');
  for (const table of tables) {
    const tableName = qualifiedName(table.reference);
    const comment = table.comment;
    if (comment !== null) {
      emit(
        tableName,
        attemptRender('UNRENDERABLE_TABLE_COMMENT', tableName, () =>
          renderComment(table.reference, null, comment),
        ),
      );
    }
    for (const column of orderedColumns(table)) {
      const columnComment = column.comment;
      if (columnComment !== null) {
        const object = `${tableName}.${column.name}`;
        emit(
          object,
          attemptRender('UNRENDERABLE_COLUMN_COMMENT', object, () =>
            renderComment(table.reference, column.name, columnComment),
          ),
        );
      }
    }
  }
}

function emitIndexes(
  tables: TableDefinition[],
  { emit, attemptRender }: SqlCollector,
): void {
  emit(
    'document',
    '-- Phase 3: standalone and constraint-supporting indexes, exactly once.',
  );
  for (const table of tables) {
    const indexes = [...table.indexes].sort((left, right) =>
      compareOrdinal(objectKey(left.reference), objectKey(right.reference)),
    );
    for (const index of indexes) {
      emit(
        qualifiedName(index.reference),
        renderIndex(table.reference, index, attemptRender),
      );
    }
  }
}

function emitLocalConstraints(
  tables: TableDefinition[],
  { emit }: SqlCollector,
): void {
  emit(
    'document',
    '-- Phase 4: local constraints and candidate keys, reusing existing indexes.',
  );
  for (const table of tables) {
    for (const constraint of orderedConstraints(table)) {
      if (constraint.kind === 'foreign-key' || constraint.kind === 'not-null') {
        continue;
      }
      emit(
        `${qualifiedName(table.reference)}/${constraint.name}`,
        renderLocalConstraint(table.reference, constraint),
      );
    }
  }
}

function emitReferenceGrants(
  tables: TableDefinition[],
  { emit }: SqlCollector,
): void {
  emit('document', '-- Phase 5: cross-schema REFERENCES grants.');
  const grants = new Map<string, string>();
  for (const table of tables) {
    for (const constraint of orderedConstraints(table)) {
      if (
        constraint.kind === 'foreign-key' &&
        constraint.parentTable.owner !== table.reference.owner
      ) {
        const parentName = qualifiedName(constraint.parentTable);
        grants.set(
          `GRANT REFERENCES ON ${parentName} TO ${quoteIdentifier(table.reference.owner)};`,
          parentName,
        );
      }
    }
  }
  for (const [sql, object] of [...grants].sort(([left], [right]) =>
    compareOrdinal(left, right),
  )) {
    emit(object, sql);
  }
}

function emitForeignKeys(
  tables: TableDefinition[],
  { emit }: SqlCollector,
): void {
  emit('document', '-- Phase 6: selected target-origin foreign keys only.');
  for (const table of tables) {
    for (const constraint of orderedConstraints(table)) {
      if (constraint.kind === 'foreign-key') {
        emit(
          `${qualifiedName(table.reference)}/${constraint.name}`,
          renderForeignKey(table.reference, constraint),
        );
      }
    }
  }
}

function emitViews(views: ViewDefinition[], { emit }: SqlCollector): void {
  emit('document', '-- Phase 7: conventional views.');
  const grants = new Set<string>();
  for (const view of views) {
    // Emit cross-schema grants immediately before the first dependent view;
    // Oracle requires the view owner to hold these privileges directly.
    const dependencies = [...view.dependencies].sort((left, right) =>
      compareOrdinal(objectKey(left.reference), objectKey(right.reference)),
    );
    for (const edge of dependencies) {
      if (!edge.databaseLink && edge.reference.owner !== view.reference.owner) {
        const privilege = ['FUNCTION', 'PACKAGE'].includes(edge.type)
          ? 'EXECUTE'
          : 'SELECT';
        const grant = `GRANT ${privilege} ON ${qualifiedName(edge.reference)} TO ${quoteIdentifier(view.reference.owner)};`;
        if (!grants.has(grant)) {
          emit(qualifiedName(view.reference), grant);
          grants.add(grant);
        }
      }
    }
    emit(qualifiedName(view.reference), renderView(view));
  }
}

/** Internal preparation of parsed metadata; never authorizes publication. */
export function prepareSql(
  document: TargetDocument,
  analysis: ReturnType<typeof analyzeTarget>,
): SqlPreparation {
  const collector = createSqlPreparation();
  const tables = [...document.tables].sort((left, right) =>
    compareOrdinal(objectKey(left.reference), objectKey(right.reference)),
  );

  emitPreamble(document, collector);
  emitSchemas(document, collector);
  for (const synonym of [...document.synonyms].sort((a, b) =>
    compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
  )) {
    collector.emit(qualifiedName(synonym.reference), renderSynonym(synonym));
  }
  for (const sequence of [...document.sequences].sort((a, b) =>
    compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
  )) {
    const name = qualifiedName(sequence.reference);
    collector.emit(
      name,
      collector.attemptRender('INVALID_SEQUENCE', name, () =>
        renderSequence(sequence),
      ),
    );
  }
  const sequenceGrants = new Set<string>();
  for (const original of document.prerequisites) {
    const edge = resolveDependency(document, original);
    if (
      edge.type === 'SEQUENCE' &&
      isIncluded(document, edge) &&
      edge.reference.owner !== edge.requiredBy.owner &&
      document.tables.some(
        (table) => objectKey(table.reference) === objectKey(edge.requiredBy),
      )
    )
      sequenceGrants.add(
        `GRANT SELECT ON ${qualifiedName(edge.reference)} TO ${quoteIdentifier(edge.requiredBy.owner)};`,
      );
  }
  for (const sql of [...sequenceGrants].sort()) collector.emit('document', sql);
  if (document.programs.length || document.synonyms.length) {
    try {
      for (const group of creationOrder(document)) {
        const programs = group.flatMap((node) =>
          node.kind === 'program' ? [node.value] : [],
        );
        // Specifications across a recursive group precede all bodies.
        for (const body of [false, true])
          for (const program of programs) {
            for (const unit of program.units)
              if ((unit.type === 'PACKAGE_BODY') === body)
                collector.emit(qualifiedName(program.reference), unit.ddl);
          }
        if (programs.length)
          collector.emit('programs', compilePrograms(programs));
        for (const node of group) {
          if (node.kind === 'table') {
            const grants = new Set(
              document.prerequisites
                .map((edge) => resolveDependency(document, edge))
                .filter(
                  (edge) =>
                    objectKey(edge.requiredBy) ===
                      objectKey(node.value.reference) &&
                    edge.origin !== 'INDEX' &&
                    ['FUNCTION', 'PACKAGE'].includes(edge.type) &&
                    isIncluded(document, edge) &&
                    edge.reference.owner !== edge.requiredBy.owner,
                )
                .map(
                  (edge) =>
                    `GRANT EXECUTE ON ${qualifiedName(edge.reference)} TO ${quoteIdentifier(edge.requiredBy.owner)};`,
                ),
            );
            for (const grant of [...grants].sort())
              collector.emit(qualifiedName(node.value.reference), grant);
            emitTables([node.value], document.policy, collector);
          }
          if (node.kind === 'view')
            emitViews(
              [
                {
                  ...node.value,
                  dependencies: node.value.dependencies.map((edge) =>
                    resolveDependency(document, edge),
                  ),
                },
              ],
              collector,
            );
        }
      }
    } catch {
      collector.result.diagnostics.push({
        severity: 'error',
        code: 'UNSUPPORTED_CREATION_CYCLE',
        object: 'document',
        message: 'Dependency cycle includes a table expression or view.',
      });
    }
  } else emitTables(tables, document.policy, collector);
  emitComments(tables, collector);
  for (const grant of indexRequirements(document).grants) {
    collector.emit(qualifiedName(grant.reference), renderIndexGrant(grant));
  }
  emitIndexes(tables, collector);
  emitLocalConstraints(tables, collector);
  emitReferenceGrants(tables, collector);
  emitForeignKeys(tables, collector);
  if (!(document.programs.length || document.synonyms.length))
    emitViews(
      analysis.orderedViews.map((view) => ({
        ...view,
        dependencies: view.dependencies.map((edge) =>
          resolveDependency(document, edge),
        ),
      })),
      collector,
    );
  // Adding table constraints can invalidate already-created views and programs.
  // Revisit the same dependency order after those mutations, compiling only invalid units.
  if (document.programs.length || document.synonyms.length) {
    try {
      for (const group of creationOrder(document)) {
        for (const node of group)
          if (node.kind === 'view') {
            const reference = node.value.reference;
            const literal = (value: string) =>
              `'${value.replaceAll("'", "''")}'`;
            collector.emit(
              qualifiedName(reference),
              `DECLARE n NUMBER; BEGIN
  SELECT COUNT(*) INTO n FROM ALL_OBJECTS WHERE owner=${literal(reference.owner)} AND object_name=${literal(reference.name)} AND object_type='VIEW' AND status='INVALID';
  IF n > 0 THEN EXECUTE IMMEDIATE ${literal(`ALTER VIEW ${qualifiedName(reference)} COMPILE`)}; END IF;
END;
/`,
            );
          }
        const programs = group.flatMap((node) =>
          node.kind === 'program' ? [node.value] : [],
        );
        if (programs.length)
          collector.emit('programs', compilePrograms(programs));
      }
    } catch {
      /* The creation pass already reports unsupported cycles. */
    }
  }
  if (document.programs.length)
    collector.emit(
      'programs',
      compilePrograms(
        [...document.programs].sort((a, b) =>
          compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
        ),
      ),
    );
  if (document.synonyms.length)
    collector.emit('synonyms', verifySynonymsSql(document));
  collector.emit('document', 'PROMPT Schema reconstruction completed.');
  return collector.result;
}
