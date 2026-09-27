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
    `-- Generated from oracle-schema-pipeline format ${document.formatVersion}. No source DDL was replayed.`,
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
  const owners = new Set([
    ...document.tables.map((table) => table.reference.owner),
    ...document.views.map((view) => view.reference.owner),
  ]);
  const tablespace = quoteIdentifier(document.policy.defaultTablespace);
  for (const owner of [...owners].sort()) {
    emit(
      quoteIdentifier(owner),
      `CREATE USER ${quoteIdentifier(owner)} NO AUTHENTICATION DEFAULT TABLESPACE ${tablespace} QUOTA UNLIMITED ON ${tablespace};`,
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
        const grant = `GRANT SELECT ON ${qualifiedName(edge.reference)} TO ${quoteIdentifier(view.reference.owner)};`;
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
  emitTables(tables, document.policy, collector);
  emitComments(tables, collector);
  emitIndexes(tables, collector);
  emitLocalConstraints(tables, collector);
  emitReferenceGrants(tables, collector);
  emitForeignKeys(tables, collector);
  emitViews(analysis.orderedViews, collector);
  collector.emit('document', 'PROMPT Schema reconstruction completed.');
  return collector.result;
}
