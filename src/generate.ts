import { analyzeTarget, compareOrdinal } from './semantic.js';
import { renderIdentity } from './identity.js';
import {
  quoteIdentifier,
  qualifiedName,
  objectKey,
  type ConstraintDefinition,
  type TableDefinition,
  type TargetDocument,
} from './model.js';
import { assertValidTarget } from './validate.js';
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
function createTable(table: TableDefinition, document: TargetDocument): string {
  const columns = [...table.columns]
    .sort((left, right) => left.position - right.position)
    .map((column) => {
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
        ? ` ${renderIdentity(column)}`
        : column.defaultExpression === null
          ? ''
          : ` DEFAULT${column.defaultOnNull ? ' ON NULL' : ''} ${column.defaultExpression.trim()}`;
      // NOT NULL is emitted from its named constraint, not inferred from NULLABLE:
      // primary keys and DEFAULT ON NULL can also explain a column's nullability.
      return `  ${name} ${renderDataType(column, document.policy)}${invisible}${defaultClause}${notNullClause}`;
    });
  return `CREATE TABLE ${qualifiedName(table.reference)} (\n${columns.join(',\n')}\n) SEGMENT CREATION DEFERRED;`;
}

/** Pure SQL generation from an independently validated target model. */
export function generateSql(input: unknown): string {
  const document = assertValidTarget(input);
  const tables = [...document.tables].sort((left, right) =>
    compareOrdinal(objectKey(left.reference), objectKey(right.reference)),
  );
  const statements: string[] = [
    '-- Generated from oracle-schema-pipeline format ' +
      document.formatVersion +
      '. No source DDL was replayed.',
    'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
    'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
    'SET DEFINE OFF',
    'SET SQLBLANKLINES ON',
    'SET ECHO ON',
    'ALTER SESSION SET DEFERRED_SEGMENT_CREATION=TRUE;',
  ];
  if (document.policy.createSchemas) {
    for (const owner of [
      ...new Set([
        ...tables.map((table) => table.reference.owner),
        ...document.views.map((view) => view.reference.owner),
      ]),
    ].sort()) {
      const tablespace = quoteIdentifier(document.policy.defaultTablespace);
      statements.push(
        `CREATE USER ${quoteIdentifier(owner)} NO AUTHENTICATION DEFAULT TABLESPACE ${tablespace} QUOTA UNLIMITED ON ${tablespace};`,
      );
    }
  }
  statements.push('-- Phase 1: all tables, without foreign keys.');
  for (const table of tables) statements.push(createTable(table, document));

  statements.push('-- Phase 2: table and column comments.');
  for (const table of tables) {
    if (table.comment !== null)
      statements.push(renderComment(table.reference, null, table.comment));
    for (const column of [...table.columns].sort(
      (left, right) => left.position - right.position,
    )) {
      if (column.comment !== null)
        statements.push(
          renderComment(table.reference, column.name, column.comment),
        );
    }
  }

  statements.push(
    '-- Phase 3: standalone and constraint-supporting indexes, exactly once.',
  );
  for (const table of tables) {
    for (const index of [...table.indexes].sort((a, b) =>
      compareOrdinal(objectKey(a.reference), objectKey(b.reference)),
    )) {
      const bitmap = index.type.includes('BITMAP');
      const modifier = bitmap ? 'BITMAP ' : index.unique ? 'UNIQUE ' : '';
      const keys = index.keys
        .map(
          (key) =>
            `${key.expression ?? quoteIdentifier(key.column!)} ${key.direction}`,
        )
        .join(', ');
      statements.push(
        `CREATE ${modifier}INDEX ${qualifiedName(index.reference)} ON ${qualifiedName(table.reference)} (${keys})${index.type === 'NORMAL/REV' ? ' REVERSE' : ''}${index.visible ? '' : ' INVISIBLE'};`,
      );
    }
  }
  statements.push(
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
        statements.push(
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
        statements.push(
          `${prefix} ADD CONSTRAINT ${constraintName} ${keyKind} (${constraint.columns.map(quoteIdentifier).join(', ')}) ${stateWithIndex};`,
        );
      }
    }
  }
  statements.push('-- Phase 5: cross-schema REFERENCES grants.');
  const referenceGrants = new Set<string>();
  for (const table of tables)
    for (const constraint of [...table.constraints].sort((a, b) =>
      compareOrdinal(a.name, b.name),
    )) {
      if (
        constraint.kind === 'foreign-key' &&
        constraint.parentTable.owner !== table.reference.owner
      ) {
        referenceGrants.add(
          `GRANT REFERENCES ON ${qualifiedName(constraint.parentTable)} TO ${quoteIdentifier(table.reference.owner)};`,
        );
      }
    }
  statements.push(...[...referenceGrants].sort());
  statements.push('-- Phase 6: selected target-origin foreign keys only.');
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
      statements.push(
        `ALTER TABLE ${qualifiedName(table.reference)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} FOREIGN KEY (${childColumns}) REFERENCES ${qualifiedName(constraint.parentTable)} (${parentColumns})${deleteClause} ${constraintState(constraint)};`,
      );
    }
  {
    statements.push('-- Phase 7: conventional views.');
    const { orderedViews: ordered } = analyzeTarget(document);
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
            statements.push(grant);
            grants.add(grant);
          }
        }
      const columns = view.columns.map(quoteIdentifier).join(', '),
        bequeath =
          view.bequeath === 'CURRENT_USER'
            ? ' BEQUEATH CURRENT_USER'
            : ' BEQUEATH DEFINER';
      const restriction = view.readOnly
        ? ' WITH READ ONLY'
        : view.checkOption === 'NONE'
          ? ''
          : ' WITH CHECK OPTION';
      statements.push(
        'CREATE VIEW ' +
          qualifiedName(view.reference) +
          ' (' +
          columns +
          ')' +
          bequeath +
          ' AS ' +
          view.query.trim() +
          restriction +
          ';',
      );
    }
  }
  statements.push('PROMPT Schema reconstruction completed.');
  const sql = statements.join('\n\n') + '\n';
  if (sql.split('\n').some((line) => Buffer.byteLength(line, 'utf8') > 2400))
    throw new Error(
      'SQL exceeds the conservative SQL*Plus input-line limit; use a reviewed SQLcl output policy.',
    );
  return sql;
}
