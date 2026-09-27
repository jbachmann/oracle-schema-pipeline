import { renderIdentity } from './identity.js';
import { renderDataType } from './types.js';
import {
  quoteIdentifier,
  qualifiedName,
  type ColumnDefinition,
  type ConstraintDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type ObjectReference,
  type TableDefinition,
  type TargetDocument,
  type ViewDefinition,
} from './model.js';
import type { AttemptRender } from './sql-preparation.js';

type LocalConstraint = Exclude<
  ConstraintDefinition,
  { kind: 'foreign-key' | 'not-null' }
>;

function renderConstraintState(constraint: ConstraintDefinition): string {
  const state = constraint.state;
  const clauses: string[] = [];
  if (constraint.kind !== 'not-null' && constraint.kind !== 'check') {
    if (state.deferrable) {
      clauses.push(
        `DEFERRABLE INITIALLY ${state.initiallyDeferred ? 'DEFERRED' : 'IMMEDIATE'}`,
      );
    } else {
      clauses.push('NOT DEFERRABLE');
    }
  }
  if (state.rely) {
    clauses.push('RELY');
  }
  // USING INDEX is part of the constraint state. Place it before ENABLE.
  if (
    (constraint.kind === 'primary-key' || constraint.kind === 'unique') &&
    constraint.backingIndex
  ) {
    clauses.push(`USING INDEX ${qualifiedName(constraint.backingIndex)}`);
  }
  clauses.push(state.enabled ? 'ENABLE' : 'DISABLE');
  clauses.push(state.validated ? 'VALIDATE' : 'NOVALIDATE');
  return clauses.join(' ');
}

function renderColumn(
  column: ColumnDefinition,
  table: TableDefinition,
  policy: TargetDocument['policy'],
  attemptRender: AttemptRender,
): string {
  const object = `${qualifiedName(table.reference)}.${column.name}`;
  const dataType = attemptRender('UNSUPPORTED_TYPE', object, () =>
    renderDataType(column, policy),
  );
  const identity = column.identity
    ? attemptRender('UNSUPPORTED_IDENTITY', object, () =>
        renderIdentity(column),
      )
    : '';
  const name = quoteIdentifier(column.name);
  const invisible = column.invisible ? ' INVISIBLE' : '';
  const notNull = table.constraints.find(
    (constraint) =>
      constraint.kind === 'not-null' && constraint.column === column.name,
  );
  const notNullClause = notNull
    ? ` CONSTRAINT ${quoteIdentifier(notNull.name)} NOT NULL ${renderConstraintState(notNull)}`
    : '';
  if (column.virtual) {
    return `  ${name}${invisible} GENERATED ALWAYS AS (${column.defaultExpression}) VIRTUAL${notNullClause}`;
  }
  let defaultClause = '';
  if (column.identity) {
    defaultClause = ` ${identity}`;
  } else if (column.defaultExpression !== null) {
    defaultClause = ` DEFAULT${column.defaultOnNull ? ' ON NULL' : ''} ${column.defaultExpression.trim()}`;
  }
  // NOT NULL is emitted from its named constraint, not inferred from NULLABLE:
  // primary keys and DEFAULT ON NULL can also explain a column's nullability.
  return `  ${name} ${dataType}${invisible}${defaultClause}${notNullClause}`;
}

export function renderTable(
  table: TableDefinition,
  columns: readonly ColumnDefinition[],
  policy: TargetDocument['policy'],
  attemptRender: AttemptRender,
): string {
  const definitions = columns.map((column) =>
    renderColumn(column, table, policy, attemptRender),
  );
  return `CREATE TABLE ${qualifiedName(table.reference)} (\n${definitions.join(',\n')}\n) SEGMENT CREATION DEFERRED;`;
}

export function renderIndex(
  table: ObjectReference,
  index: IndexDefinition,
  attemptRender: AttemptRender,
): string {
  let modifier = '';
  if (index.type.includes('BITMAP')) {
    modifier = 'BITMAP ';
  } else if (index.unique) {
    modifier = 'UNIQUE ';
  }
  const keys = attemptRender(
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
  const reverse = index.type === 'NORMAL/REV' ? ' REVERSE' : '';
  const invisible = index.visible ? '' : ' INVISIBLE';
  return `CREATE ${modifier}INDEX ${qualifiedName(index.reference)} ON ${qualifiedName(table)} (${keys})${reverse}${invisible};`;
}

export function renderLocalConstraint(
  table: ObjectReference,
  constraint: LocalConstraint,
): string {
  const prefix = `ALTER TABLE ${qualifiedName(table)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)}`;
  const state = renderConstraintState(constraint);
  if (constraint.kind === 'check') {
    return `${prefix} CHECK (${constraint.expression}) ${state};`;
  }
  const keyKind = constraint.kind === 'primary-key' ? 'PRIMARY KEY' : 'UNIQUE';
  const columns = constraint.columns.map(quoteIdentifier).join(', ');
  return `${prefix} ${keyKind} (${columns}) ${state};`;
}

export function renderForeignKey(
  table: ObjectReference,
  constraint: ForeignKeyDefinition,
): string {
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
  return `ALTER TABLE ${qualifiedName(table)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} FOREIGN KEY (${childColumns}) REFERENCES ${qualifiedName(constraint.parentTable)} (${parentColumns})${deleteClause} ${renderConstraintState(constraint)};`;
}

export function renderView(view: ViewDefinition): string {
  const columns = view.columns.map(quoteIdentifier).join(', ');
  const bequeath =
    view.bequeath === 'CURRENT_USER'
      ? ' BEQUEATH CURRENT_USER'
      : ' BEQUEATH DEFINER';
  // Format v4 query text owns restriction syntax; fields are catalog facts.
  return `CREATE VIEW ${qualifiedName(view.reference)} (${columns})${bequeath} AS ${view.query.trim()};`;
}
