import { compareOrdinal, type analyzeTarget } from './semantic.js';
import { renderIdentity } from './identity.js';
import {
  quoteIdentifier,
  qualifiedName,
  objectKey,
  type Diagnostic,
  type ConstraintDefinition,
  type TableDefinition,
  type TargetDocument,
} from './model.js';
import { renderDataType } from './types.js';
import { renderComment } from './comments.js';

function constraintState(constraint: ConstraintDefinition): string {
  const state = constraint.state;
  const deferral =
    constraint.kind === 'not-null' || constraint.kind === 'check'
      ? ''
      : state.deferrable
        ? `DEFERRABLE INITIALLY ${state.initiallyDeferred ? 'DEFERRED' : 'IMMEDIATE'} `
        : 'NOT DEFERRABLE ';
  return `${deferral}${state.rely ? 'RELY ' : ''}${state.enabled ? 'ENABLE' : 'DISABLE'} ${state.validated ? 'VALIDATE' : 'NOVALIDATE'}`;
}
function createTable(
  table: TableDefinition,
  document: TargetDocument,
  diagnostics: Diagnostic[],
): string {
  const columns = [...table.columns]
    .sort((left, right) => left.position - right.position)
    .map((column) => {
      const object = `${qualifiedName(table.reference)}.${column.name}`;
      const dataType = attemptRender(
        diagnostics,
        'UNSUPPORTED_TYPE',
        object,
        () => renderDataType(column, document.policy),
      );
      const identity = column.identity
        ? attemptRender(diagnostics, 'UNSUPPORTED_IDENTITY', object, () =>
            renderIdentity(column),
          )
        : '';
      const name = quoteIdentifier(column.name),
        invisible = column.invisible ? ' INVISIBLE' : '';
      const notNull = table.constraints.find(
        (constraint) =>
          constraint.kind === 'not-null' && constraint.column === column.name,
      );
      const notNullClause = notNull
        ? ` CONSTRAINT ${quoteIdentifier(notNull.name)} NOT NULL ${constraintState(notNull)}`
        : '';
      if (column.virtual)
        return `  ${name}${invisible} GENERATED ALWAYS AS (${column.defaultExpression}) VIRTUAL${notNullClause}`;
      const defaultClause = column.identity
        ? ` ${identity}`
        : column.defaultExpression === null
          ? ''
          : ` DEFAULT${column.defaultOnNull ? ' ON NULL' : ''} ${column.defaultExpression.trim()}`;
      // NOT NULL is emitted from its named constraint, not inferred from NULLABLE:
      // primary keys and DEFAULT ON NULL can also explain a column's nullability.
      return `  ${name} ${dataType}${invisible}${defaultClause}${notNullClause}`;
    });
  return `CREATE TABLE ${qualifiedName(table.reference)} (\n${columns.join(',\n')}\n) SEGMENT CREATION DEFERRED;`;
}

const sqlLineLimit = 2400;

interface SqlOperation {
  object: string;
  sql: string;
}

function attemptRender(
  diagnostics: Diagnostic[],
  code: string,
  object: string,
  render: () => string,
): string {
  try {
    return render();
  } catch (reason) {
    diagnostics.push({
      severity: 'error',
      code,
      object,
      message: String(reason),
    });
    // This preparation is diagnostic-only when any renderer fails.
    return '';
  }
}

/** Internal preparation of parsed metadata; never authorizes publication. */
export function prepareSql(
  document: TargetDocument,
  analysis: ReturnType<typeof analyzeTarget>,
) {
  const diagnostics: Diagnostic[] = [];
  const operations: SqlOperation[] = [];
  const emit = (object: string, ...statements: string[]): void => {
    for (const sql of statements) {
      operations.push({ object, sql });
      for (const [index, line] of sql.split('\n').entries()) {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > sqlLineLimit)
          diagnostics.push({
            severity: 'error',
            code: 'SQL_LINE_LIMIT',
            object,
            message: `Rendered SQL line ${index + 1} is ${bytes} UTF-8 bytes; the conservative SQL*Plus limit is ${sqlLineLimit} bytes.`,
          });
      }
    }
  };
  const tables = [...document.tables].sort((left, right) =>
    compareOrdinal(objectKey(left.reference), objectKey(right.reference)),
  );
  emit(
    'document',
    '-- Generated from oracle-schema-pipeline format ' +
      document.formatVersion +
      '. No source DDL was replayed.',
    'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
    'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
    'SET DEFINE OFF',
    'SET SQLBLANKLINES ON',
    'SET ECHO ON',
    'ALTER SESSION SET DEFERRED_SEGMENT_CREATION=TRUE;',
  );
  if (document.policy.createSchemas) {
    for (const owner of [
      ...new Set([
        ...tables.map((table) => table.reference.owner),
        ...document.views.map((view) => view.reference.owner),
      ]),
    ].sort()) {
      const tablespace = quoteIdentifier(document.policy.defaultTablespace);
      emit(
        quoteIdentifier(owner),
        `CREATE USER ${quoteIdentifier(owner)} NO AUTHENTICATION DEFAULT TABLESPACE ${tablespace} QUOTA UNLIMITED ON ${tablespace};`,
      );
    }
  }
  emit('document', '-- Phase 1: all tables, without foreign keys.');
  for (const table of tables)
    emit(
      qualifiedName(table.reference),
      createTable(table, document, diagnostics),
    );

  emit('document', '-- Phase 2: table and column comments.');
  for (const table of tables) {
    if (table.comment !== null)
      emit(
        qualifiedName(table.reference),
        attemptRender(
          diagnostics,
          'UNRENDERABLE_TABLE_COMMENT',
          qualifiedName(table.reference),
          () => renderComment(table.reference, null, table.comment!),
        ),
      );
    for (const column of [...table.columns].sort(
      (left, right) => left.position - right.position,
    )) {
      if (column.comment !== null)
        emit(
          `${qualifiedName(table.reference)}.${column.name}`,
          attemptRender(
            diagnostics,
            'UNRENDERABLE_COLUMN_COMMENT',
            `${qualifiedName(table.reference)}.${column.name}`,
            () => renderComment(table.reference, column.name, column.comment!),
          ),
        );
    }
  }

  emit(
    'document',
    '-- Phase 3: standalone and constraint-supporting indexes, exactly once.',
  );
  for (const table of tables) {
    for (const index of [...table.indexes].sort((a, b) =>
      compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
    )) {
      const bitmap = index.type.includes('BITMAP');
      const modifier = bitmap ? 'BITMAP ' : index.unique ? 'UNIQUE ' : '';
      const keys = attemptRender(
        diagnostics,
        'UNRENDERABLE_INDEX_KEY',
        qualifiedName(index.reference),
        () =>
          index.keys
            .map(
              (key) =>
                `${key.expression ?? quoteIdentifier(key.column!)} ${key.direction}`,
            )
            .join(', '),
      );
      emit(
        qualifiedName(index.reference),
        `CREATE ${modifier}INDEX ${qualifiedName(index.reference)} ON ${qualifiedName(table.reference)} (${keys})${index.type === 'NORMAL/REV' ? ' REVERSE' : ''}${index.visible ? '' : ' INVISIBLE'};`,
      );
    }
  }
  emit(
    'document',
    '-- Phase 4: local constraints and candidate keys, reusing existing indexes.',
  );
  for (const table of tables) {
    for (const constraint of [...table.constraints].sort((a, b) =>
      compareOrdinal(a.name, b.name),
    )) {
      const prefix = `ALTER TABLE ${qualifiedName(table.reference)}`;
      const constraintName = quoteIdentifier(constraint.name);
      if (constraint.kind === 'foreign-key' || constraint.kind === 'not-null')
        continue;
      if (constraint.kind === 'check') {
        emit(
          `${qualifiedName(table.reference)}/${constraint.name}`,
          `${prefix} ADD CONSTRAINT ${constraintName} CHECK (${constraint.expression}) ${constraintState(constraint)};`,
        );
      } else {
        const keyKind =
          constraint.kind === 'primary-key' ? 'PRIMARY KEY' : 'UNIQUE';
        // USING INDEX is part of the constraint state. Place it before ENABLE.
        const state = constraintState(constraint);
        const indexClause = constraint.backingIndex
          ? `USING INDEX ${qualifiedName(constraint.backingIndex)} `
          : '';
        const stateWithIndex = state.replace(
          /(ENABLE|DISABLE) (VALIDATE|NOVALIDATE)$/,
          (_match, enabled, validation) =>
            `${indexClause}${enabled} ${validation}`,
        );
        emit(
          `${qualifiedName(table.reference)}/${constraint.name}`,
          `${prefix} ADD CONSTRAINT ${constraintName} ${keyKind} (${constraint.columns.map(quoteIdentifier).join(', ')}) ${stateWithIndex};`,
        );
      }
    }
  }
  emit('document', '-- Phase 5: cross-schema REFERENCES grants.');
  const referenceGrants = new Map<string, string>();
  for (const table of tables)
    for (const constraint of [...table.constraints].sort((a, b) =>
      compareOrdinal(a.name, b.name),
    )) {
      if (
        constraint.kind === 'foreign-key' &&
        constraint.parentTable.owner !== table.reference.owner
      ) {
        referenceGrants.set(
          `GRANT REFERENCES ON ${qualifiedName(constraint.parentTable)} TO ${quoteIdentifier(table.reference.owner)};`,
          qualifiedName(constraint.parentTable),
        );
      }
    }
  for (const [sql, object] of [...referenceGrants].sort(([a], [b]) =>
    compareOrdinal(a, b),
  ))
    emit(object, sql);
  emit('document', '-- Phase 6: selected target-origin foreign keys only.');
  for (const table of tables)
    for (const constraint of [...table.constraints].sort((a, b) =>
      compareOrdinal(a.name, b.name),
    )) {
      if (constraint.kind !== 'foreign-key') continue;
      const childColumns = constraint.columnPairs
        .map((pair) => quoteIdentifier(pair.childColumn))
        .join(', ');
      const parentColumns = constraint.columnPairs
        .map((pair) => quoteIdentifier(pair.parentColumn))
        .join(', ');
      const deleteClause =
        constraint.onDelete === 'NO ACTION'
          ? ''
          : ` ON DELETE ${constraint.onDelete}`;
      emit(
        `${qualifiedName(table.reference)}/${constraint.name}`,
        `ALTER TABLE ${qualifiedName(table.reference)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} FOREIGN KEY (${childColumns}) REFERENCES ${qualifiedName(constraint.parentTable)} (${parentColumns})${deleteClause} ${constraintState(constraint)};`,
      );
    }
  {
    emit('document', '-- Phase 7: conventional views.');
    const { orderedViews: ordered } = analysis;
    const grants = new Set<string>();
    for (const view of ordered) {
      // Emit cross-schema grants immediately before the first dependent view;
      // Oracle requires the view owner to hold these privileges directly.
      for (const edge of [...view.dependencies].sort((a, b) =>
        compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
      ))
        if (
          !edge.databaseLink &&
          edge.reference.owner !== view.reference.owner
        ) {
          const grant =
            'GRANT SELECT ON ' +
            qualifiedName(edge.reference) +
            ' TO ' +
            quoteIdentifier(view.reference.owner) +
            ';';
          if (!grants.has(grant)) {
            emit(qualifiedName(view.reference), grant);
            grants.add(grant);
          }
        }
      const columns = view.columns.map(quoteIdentifier).join(', '),
        bequeath =
          view.bequeath === 'CURRENT_USER'
            ? ' BEQUEATH CURRENT_USER'
            : ' BEQUEATH DEFINER';
      // Format v4 query text owns restriction syntax; fields are catalog facts.
      emit(
        qualifiedName(view.reference),
        'CREATE VIEW ' +
          qualifiedName(view.reference) +
          ' (' +
          columns +
          ')' +
          bequeath +
          ' AS ' +
          view.query.trim() +
          ';',
      );
    }
  }
  emit('document', 'PROMPT Schema reconstruction completed.');
  return { operations, diagnostics };
}
