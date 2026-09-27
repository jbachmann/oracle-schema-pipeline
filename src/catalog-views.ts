/**
 * Reads view definitions and dependencies for the catalog adapter. View assembly
 * preserves the full query text, checks ordered columns and restriction metadata,
 * and records unsupported features for downstream validation. Dependency reads
 * return direct catalog references; extraction follows those references to select
 * dependent views and tables and populate the source document.
 */
import type { CatalogReader } from './catalog-reader.js';
import {
  qualifiedName,
  type ObjectReference,
  type ViewDefinition,
} from './model.js';
import {
  catalogFailure,
  uniqueRows,
  orderedRows,
  singleRow,
} from './catalog-decoding.js';
import {
  viewRowSchema,
  dependencyRowSchema,
  orderedColumnRowSchema,
  viewRestrictionRowSchema,
} from './catalog-schemas.js';

export async function readView(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<ViewDefinition> {
  const binds = { owner: reference.owner, viewName: reference.name };
  const rows = await reader.rows(
    'view',
    viewRowSchema,
    `SELECT v.text, v.read_only, v.bequeath, v.editioning_view, v.container_data,
           v.default_collation, v.type_text, v.superview_name, o.status, u.oracle_maintained
      FROM ${reader.catalogView('views')} v
      JOIN ${reader.catalogView('objects')} o
        ON o.owner=v.owner AND o.object_name=v.view_name AND o.object_type='VIEW'
      JOIN ${reader.catalogView('users')} u ON u.username=v.owner
     WHERE v.owner=:owner AND v.view_name=:viewName`,
    binds,
  );
  const row = singleRow(rows, qualifiedName(reference), 'view');
  const columns = await reader.rows(
    'view-columns',
    orderedColumnRowSchema,
    `SELECT column_name, column_id AS position
      FROM ${reader.catalogView('tabColumns')}
     WHERE owner=:owner AND table_name=:viewName
     ORDER BY column_id`,
    binds,
  );
  orderedRows(columns, 'POSITION', qualifiedName(reference));
  uniqueRows(columns, ['COLUMN_NAME'], qualifiedName(reference));
  const restrictions = await reader.rows(
    'view-restrictions',
    viewRestrictionRowSchema,
    `SELECT constraint_name, constraint_type, status
      FROM ${reader.catalogView('constraints')}
     WHERE owner=:owner AND table_name=:viewName AND constraint_type IN ('V','O')`,
    binds,
  );
  if (restrictions.length > 1) {
    catalogFailure(
      'CATALOG_CARDINALITY',
      qualifiedName(reference),
      'restrictions',
    );
  }
  const readOnly = row.READ_ONLY === 'Y';
  if (readOnly !== (restrictions[0]?.CONSTRAINT_TYPE === 'O')) {
    catalogFailure(
      'CATALOG_INCOMPLETE_METADATA',
      qualifiedName(reference),
      'READ_ONLY',
      'Restriction metadata disagrees',
    );
  }
  const unsupportedFeatures: string[] = [];
  if (row.ORACLE_MAINTAINED !== 'N') {
    unsupportedFeatures.push('Oracle-maintained schema');
  }
  if (row.EDITIONING_VIEW === 'Y') {
    unsupportedFeatures.push('Editioning view');
  }
  if (row.TYPE_TEXT || row.SUPERVIEW_NAME) {
    unsupportedFeatures.push('Typed or superview');
  }
  if (row.CONTAINER_DATA === 'Y') {
    unsupportedFeatures.push('Container-data view');
  }
  return {
    reference,
    role: 'target',
    columns: columns.map((column) => column.COLUMN_NAME),
    query: row.TEXT,
    readOnly,
    checkOption: restrictions[0]?.CONSTRAINT_TYPE === 'V' ? 'CASCADED' : 'NONE',
    bequeath: row.BEQUEATH,
    status: row.STATUS,
    collation: row.DEFAULT_COLLATION,
    editioning: row.EDITIONING_VIEW === 'Y',
    typed: Boolean(row.TYPE_TEXT),
    superview: Boolean(row.SUPERVIEW_NAME),
    containerData: row.CONTAINER_DATA === 'Y',
    dependencies: [],
    unsupportedFeatures,
  };
}

export async function readViewDependencies(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<ViewDefinition['dependencies']> {
  const rows = await reader.rows(
    'view-dependencies',
    dependencyRowSchema,
    `SELECT DISTINCT referenced_owner, referenced_name, referenced_type, referenced_link_name
      FROM ${reader.catalogView('dependencies')}
     WHERE owner=:owner AND name=:viewName AND type='VIEW'
     ORDER BY referenced_owner, referenced_name, referenced_type`,
    { owner: reference.owner, viewName: reference.name },
  );
  uniqueRows(
    rows,
    [
      'REFERENCED_OWNER',
      'REFERENCED_NAME',
      'REFERENCED_TYPE',
      'REFERENCED_LINK_NAME',
    ],
    qualifiedName(reference),
  );
  return rows.map((row) => ({
    reference: {
      owner: row.REFERENCED_OWNER ?? 'PUBLIC',
      name: row.REFERENCED_NAME,
    },
    type: row.REFERENCED_TYPE,
    databaseLink: row.REFERENCED_LINK_NAME,
  }));
}
