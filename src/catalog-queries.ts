/** Shared SQL definitions for on-demand reads and bounded cross-object prefetch.
 * The selection slot is an outer-query join location; bound selection rows never
 * interpolate identifiers or union catalog LONG values. */
import type { CatalogReader, CatalogQuery } from './catalog-reader.js';
import {
  columnCommentRowSchema,
  columnRowSchema,
  commentRowSchema,
  constraintRowSchema,
  dependencyRowSchema,
  prerequisiteRowSchema,
  identityRowSchema,
  indexRowSchema,
  orderedColumnRowSchema,
  tableRowSchema,
  viewRestrictionRowSchema,
  viewRowSchema,
} from './catalog-schemas.js';

export function catalogQueries(reader: CatalogReader) {
  return {
    prerequisites: {
      category: 'prerequisites',
      schema: prerequisiteRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT DISTINCT d.type AS prerequisite_origin, d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name
        FROM ${reader.catalogView('dependencies')} d
       /* selection */
       WHERE ((d.owner=:owner AND d.name=:tableName AND d.type='TABLE') OR
         (d.type='INDEX' AND EXISTS (
           SELECT 1
             FROM ${reader.catalogView('indexes')} i
            WHERE i.owner=d.owner AND i.index_name=d.name
              AND i.table_owner=:owner AND i.table_name=:tableName)))
         AND (d.referenced_link_name IS NOT NULL OR
           (d.referenced_type<>'TABLE' AND NOT EXISTS (
             SELECT 1
               FROM ${reader.catalogView('users')} u
              WHERE u.username=d.referenced_owner AND u.oracle_maintained='Y')))
         AND NOT EXISTS (
           SELECT 1
             FROM ${reader.catalogView('tabIdentityCols')} identity_column
            WHERE identity_column.owner=d.referenced_owner
              AND identity_column.sequence_name=d.referenced_name
              AND d.referenced_type='SEQUENCE')
       ORDER BY d.referenced_owner, d.referenced_name`,
    },
    table: {
      category: 'table',
      schema: tableRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT t.tablespace_name, t.compression, t.iot_type, t.cluster_name,
           t.nested, t.secondary, t.temporary, t.partitioned, u.oracle_maintained,
           (SELECT COUNT(*)
              FROM ${reader.catalogView('externalTables')} e
             WHERE e.owner=t.owner AND e.table_name=t.table_name)
         + (SELECT COUNT(*)
              FROM ${reader.catalogView('objectTables')} o
             WHERE o.owner=t.owner AND o.table_name=t.table_name)
         + (SELECT COUNT(*)
              FROM ${reader.catalogView('mviews')} m
             WHERE m.owner=t.owner AND m.mview_name=t.table_name)
         + (SELECT COUNT(*)
              FROM ${reader.catalogView('encryptedColumns')} e
             WHERE e.owner=t.owner AND e.table_name=t.table_name) AS special_count
      FROM ${reader.catalogView('tables')} t
      JOIN ${reader.catalogView('users')} u ON u.username=t.owner
     /* selection */
     WHERE t.owner=:owner AND t.table_name=:tableName`,
    },
    'table-comments': {
      category: 'table-comments',
      schema: commentRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT comments
      FROM ${reader.catalogView('tabComments')}
     /* selection */
     WHERE owner=:owner AND table_name=:tableName AND table_type='TABLE'`,
    },
    identities: {
      category: 'identities',
      schema: identityRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT column_name, generation_type, identity_options
      FROM ${reader.catalogView('tabIdentityCols')}
     /* selection */
     WHERE owner=:owner AND table_name=:tableName`,
    },
    columns: {
      category: 'columns',
      schema: columnRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT column_name, column_id, internal_column_id, data_type, data_type_owner,
           data_length, char_length, char_used, data_precision, data_scale,
           nullable, data_default, identity_column, default_on_null,
           virtual_column, hidden_column, collation
      FROM ${reader.catalogView('tabCols')}
     /* selection */
     WHERE owner=:owner AND table_name=:tableName AND user_generated='YES'
     ORDER BY column_id NULLS LAST, internal_column_id`,
    },
    'column-comments': {
      category: 'column-comments',
      schema: columnCommentRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT cc.column_name, cc.comments
      FROM ${reader.catalogView('colComments')} cc
      JOIN ${reader.catalogView('tabCols')} tc
        ON tc.owner=cc.owner AND tc.table_name=cc.table_name AND tc.column_name=cc.column_name
     /* selection */
     WHERE cc.owner=:owner AND cc.table_name=:tableName AND tc.user_generated='YES'`,
    },
    indexes: {
      category: 'indexes',
      schema: indexRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT owner, index_name, index_type, uniqueness, visibility, status,
           partitioned, compression
      FROM ${reader.catalogView('indexes')}
     /* selection */
     WHERE table_owner=:owner AND table_name=:tableName AND index_type<>'LOB'
     ORDER BY owner, index_name`,
    },
    'index-dependencies': {
      category: 'index-dependencies',
      schema: dependencyRowSchema,
      bindNames: ['owner', 'indexName', 'tableOwner', 'tableName'],
      sql: `SELECT DISTINCT d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name
       FROM ${reader.catalogView('dependencies')} d
      /* selection */
     WHERE d.owner=:owner AND d.name=:indexName AND d.type='INDEX'
        AND (d.referenced_link_name IS NOT NULL OR
          ((d.referenced_owner IS NULL OR NOT (d.referenced_type='TABLE' AND d.referenced_owner=:tableOwner AND d.referenced_name=:tableName)) AND NOT EXISTS (
            SELECT 1 FROM ${reader.catalogView('users')} u
             WHERE u.username=d.referenced_owner AND u.oracle_maintained='Y')))
      ORDER BY d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name`,
    },
    view: {
      category: 'view',
      schema: viewRowSchema,
      bindNames: ['owner', 'viewName'],
      sql: `SELECT v.text, v.read_only, v.bequeath, v.editioning_view, v.container_data,
           v.default_collation, v.type_text, v.superview_name, o.status, u.oracle_maintained
      FROM ${reader.catalogView('views')} v
      JOIN ${reader.catalogView('objects')} o
        ON o.owner=v.owner AND o.object_name=v.view_name AND o.object_type='VIEW'
      JOIN ${reader.catalogView('users')} u ON u.username=v.owner
     /* selection */
     WHERE v.owner=:owner AND v.view_name=:viewName`,
    },
    'view-columns': {
      category: 'view-columns',
      schema: orderedColumnRowSchema,
      bindNames: ['owner', 'viewName'],
      sql: `SELECT column_name, column_id AS position
      FROM ${reader.catalogView('tabColumns')}
     /* selection */
     WHERE owner=:owner AND table_name=:viewName
     ORDER BY column_id`,
    },
    'view-restrictions': {
      category: 'view-restrictions',
      schema: viewRestrictionRowSchema,
      bindNames: ['owner', 'viewName'],
      sql: `SELECT constraint_name, constraint_type, status
      FROM ${reader.catalogView('constraints')}
     /* selection */
     WHERE owner=:owner AND table_name=:viewName AND constraint_type IN ('V','O')`,
    },
    'view-dependencies': {
      category: 'view-dependencies',
      schema: dependencyRowSchema,
      bindNames: ['owner', 'viewName'],
      sql: `SELECT DISTINCT referenced_owner, referenced_name, referenced_type, referenced_link_name
      FROM ${reader.catalogView('dependencies')}
     /* selection */
     WHERE owner=:owner AND name=:viewName AND type='VIEW'
     ORDER BY referenced_owner, referenced_name, referenced_type`,
    },
    constraints: {
      category: 'constraints',
      schema: constraintRowSchema,
      bindNames: ['owner', 'tableName'],
      sql: `SELECT c.owner, c.constraint_name, c.constraint_type, c.generated,
             c.status, c.validated, c.deferrable, c.deferred, c.rely,
             c.search_condition, c.index_owner, c.index_name,
             c.r_owner, c.r_constraint_name, c.delete_rule,
             p.table_name AS parent_table_name
        FROM ${reader.catalogView('constraints')} c
        LEFT JOIN ${reader.catalogView('constraints')} p
          ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
       /* selection */
     WHERE c.owner=:owner AND c.table_name=:tableName
       ORDER BY c.constraint_name`,
    },
    'constraint-columns': {
      category: 'constraint-columns',
      schema: orderedColumnRowSchema,
      bindNames: ['owner', 'constraintName'],
      sql: `SELECT column_name, position
        FROM ${reader.catalogView('consColumns')}
       /* selection */
     WHERE owner=:owner AND constraint_name=:constraintName
       ORDER BY position`,
    },
  } satisfies Record<string, CatalogQuery>;
}
