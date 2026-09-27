/**
 * Assembles source table definitions from Oracle catalog rows: physical facts,
 * comments, columns, identities, constraints, and index keys or expressions.
 * Cross-row checks reject incomplete or inconsistent metadata before returning a
 * definition, while unsupported table features are recorded for later validation.
 * Queries use the adapter's shared reader, and constraint assembly uses its shared
 * constraint reader so dependency discovery and table reads reuse the same cache.
 */
import type { CatalogReader } from './catalog-reader.js';
import type { ConstraintReader } from './catalog-constraints.js';
import {
  qualifiedName,
  objectKey,
  type ColumnDefinition,
  type IndexDefinition,
  type ObjectReference,
  type TableDefinition,
} from './model.js';
import {
  catalogFailure,
  uniqueRows,
  orderedRows,
  singleRow,
} from './catalog-decoding.js';
import {
  tableRowSchema,
  columnRowSchema,
  commentRowSchema,
  columnCommentRowSchema,
  indexRowSchema,
  identityRowSchema,
  indexExpressionRowSchema,
  indexColumnRowSchema,
} from './catalog-schemas.js';

export async function readTable(
  reader: CatalogReader,
  constraintReader: ConstraintReader,
  reference: ObjectReference,
): Promise<TableDefinition> {
  const binds = { owner: reference.owner, tableName: reference.name };
  const rows = await reader.rows(
    'table',
    tableRowSchema,
    `SELECT t.tablespace_name, t.compression, t.iot_type, t.cluster_name,
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
     WHERE t.owner=:owner AND t.table_name=:tableName`,
    binds,
  );
  const table = singleRow(rows, qualifiedName(reference), 'table');
  const tableComments = await reader.rows(
    'table-comments',
    commentRowSchema,
    `SELECT comments
      FROM ${reader.catalogView('tabComments')}
     WHERE owner=:owner AND table_name=:tableName AND table_type='TABLE'`,
    binds,
  );
  const tableComment = singleRow(
    tableComments,
    qualifiedName(reference),
    'COMMENTS',
  );
  const unsupportedFeatures: string[] = [];
  if (table.IOT_TYPE) {
    unsupportedFeatures.push(`Index-organized table: ${table.IOT_TYPE}`);
  }
  if (table.CLUSTER_NAME) {
    unsupportedFeatures.push(`Cluster: ${table.CLUSTER_NAME}`);
  }
  if (table.NESTED !== 'NO' || table.SECONDARY !== 'N') {
    unsupportedFeatures.push('Nested or secondary storage table');
  }
  if (table.TEMPORARY !== 'N') {
    unsupportedFeatures.push('Temporary table');
  }
  if (table.PARTITIONED !== 'NO') {
    unsupportedFeatures.push('Partitioned table');
  }
  if (table.ORACLE_MAINTAINED !== 'N') {
    unsupportedFeatures.push('Oracle-maintained schema');
  }
  if (table.SPECIAL_COUNT) {
    unsupportedFeatures.push(
      'External/object/materialized-view table or encrypted column',
    );
  }

  const columns = await readColumns(reader, reference);
  const { definitions: constraints, unsupportedFeatures: constraintFeatures } =
    await constraintReader.tableConstraints(
      reference,
      new Set(columns.map((column) => column.name)),
    );
  unsupportedFeatures.push(...constraintFeatures);
  return {
    reference,
    role: 'target',
    comment: tableComment.COMMENTS,
    unsupportedFeatures,
    sourcePhysical: {
      tablespace: table.TABLESPACE_NAME,
      compression: table.COMPRESSION,
    },
    columns,
    constraints,
    indexes: await readIndexes(reader, reference),
  };
}

async function readColumns(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<ColumnDefinition[]> {
  const binds = { owner: reference.owner, tableName: reference.name };
  const identities = await reader.rows(
    'identities',
    identityRowSchema,
    `SELECT column_name, generation_type, identity_options
      FROM ${reader.catalogView('tabIdentityCols')}
     WHERE owner=:owner AND table_name=:tableName`,
    binds,
  );
  uniqueRows(identities, ['COLUMN_NAME'], qualifiedName(reference));
  const identityByColumn = new Map(
    identities.map((row) => [row.COLUMN_NAME, row]),
  );
  // USER_GENERATED retains invisible user columns but excludes internal columns
  // backing function-based indexes. Those indexes are modeled as expressions.
  const columnRows = await reader.rows(
    'columns',
    columnRowSchema,
    `SELECT column_name, column_id, internal_column_id, data_type, data_type_owner,
           data_length, char_length, char_used, data_precision, data_scale,
           nullable, data_default, identity_column, default_on_null,
           virtual_column, hidden_column, collation
      FROM ${reader.catalogView('tabCols')}
     WHERE owner=:owner AND table_name=:tableName AND user_generated='YES'
     ORDER BY column_id NULLS LAST, internal_column_id`,
    binds,
  );
  const columnCommentRows = await reader.rows(
    'column-comments',
    columnCommentRowSchema,
    `SELECT cc.column_name, cc.comments
      FROM ${reader.catalogView('colComments')} cc
      JOIN ${reader.catalogView('tabCols')} tc
        ON tc.owner=cc.owner AND tc.table_name=cc.table_name AND tc.column_name=cc.column_name
     WHERE cc.owner=:owner AND cc.table_name=:tableName AND tc.user_generated='YES'`,
    binds,
  );
  uniqueRows(columnRows, ['COLUMN_NAME'], qualifiedName(reference));
  uniqueRows(columnRows, ['INTERNAL_COLUMN_ID'], qualifiedName(reference));
  uniqueRows(
    columnRows.filter((column) => column.COLUMN_ID !== null),
    ['COLUMN_ID'],
    qualifiedName(reference),
  );
  // Internal positions can have legitimate gaps after dropped/system columns.
  for (const column of columnRows) {
    if (
      (column.IDENTITY_COLUMN === 'YES') !==
      identityByColumn.has(column.COLUMN_NAME)
    ) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference) + '.' + column.COLUMN_NAME,
        'IDENTITY_COLUMN',
      );
    }
  }
  if (!columnRows.length) {
    catalogFailure(
      'CATALOG_INCOMPLETE_METADATA',
      qualifiedName(reference),
      'columns',
    );
  }
  const commentByColumn = new Map<string, string | null>();
  for (const row of columnCommentRows) {
    if (commentByColumn.has(row.COLUMN_NAME)) {
      catalogFailure(
        'CATALOG_CARDINALITY',
        qualifiedName(reference) + '.' + row.COLUMN_NAME,
        'COMMENTS',
        'Duplicate column comment row',
      );
    }
    commentByColumn.set(row.COLUMN_NAME, row.COMMENTS);
  }
  const modeledNames = new Set(columnRows.map((row) => row.COLUMN_NAME));
  for (const name of identityByColumn.keys()) {
    if (!modeledNames.has(name)) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference) + '.' + name,
        'identity',
        'Missing or inaccessible identity column metadata',
      );
    }
  }
  for (const name of commentByColumn.keys()) {
    if (!modeledNames.has(name)) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference) + '.' + name,
        'COMMENTS',
        'Unexpected column comment row',
      );
    }
  }
  for (const name of modeledNames) {
    if (!commentByColumn.has(name)) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference) + '.' + name,
        'COMMENTS',
        'Missing column comment row',
      );
    }
  }
  const columns: ColumnDefinition[] = columnRows.map((column, position) => {
    const identity = identityByColumn.get(column.COLUMN_NAME);
    return {
      name: column.COLUMN_NAME,
      position: position + 1,
      comment: commentByColumn.get(column.COLUMN_NAME)!,
      dataType: {
        name: column.DATA_TYPE,
        owner: column.DATA_TYPE_OWNER,
        byteLength: column.DATA_LENGTH,
        characterLength: column.CHAR_LENGTH,
        lengthSemantics:
          column.CHAR_USED === 'C'
            ? 'CHAR'
            : column.CHAR_USED === 'B'
              ? 'BYTE'
              : null,
        precision: column.DATA_PRECISION,
        scale: column.DATA_SCALE,
      },
      nullable: column.NULLABLE === 'Y',
      defaultExpression: column.DATA_DEFAULT,
      defaultOnNull: column.DEFAULT_ON_NULL === 'YES',
      virtual: column.VIRTUAL_COLUMN === 'YES',
      invisible: column.HIDDEN_COLUMN === 'YES',
      collation: column.COLLATION,
      identity: identity
        ? {
            generation: identity.GENERATION_TYPE,
            options: identity.IDENTITY_OPTIONS,
          }
        : null,
    };
  });
  return columns;
}

async function readIndexes(
  reader: CatalogReader,
  table: ObjectReference,
): Promise<IndexDefinition[]> {
  const indexRows = await reader.rows(
    'indexes',
    indexRowSchema,
    `SELECT owner, index_name, index_type, uniqueness, visibility, status,
           partitioned, compression
      FROM ${reader.catalogView('indexes')}
     WHERE table_owner=:owner AND table_name=:tableName AND index_type<>'LOB'
     ORDER BY owner, index_name`,
    { owner: table.owner, tableName: table.name },
  );
  uniqueRows(indexRows, ['OWNER', 'INDEX_NAME'], qualifiedName(table));
  const references = indexRows.map((index) => ({
    owner: index.OWNER,
    name: index.INDEX_NAME,
  }));
  const expressionGroups = await reader.memberRows(references, {
    category: 'index-expressions',
    schema: indexExpressionRowSchema,
    view: 'indExpressions',
    ownerColumn: 'index_owner',
    nameColumn: 'index_name',
    fields: 'column_position,column_expression',
    position: 'column_position',
    singleBind: 'indexName',
  });
  const keyGroups = await reader.memberRows(references, {
    category: 'index-columns',
    schema: indexColumnRowSchema,
    view: 'indColumns',
    ownerColumn: 'index_owner',
    nameColumn: 'index_name',
    fields: 'column_name,column_position,descend',
    position: 'column_position',
    singleBind: 'indexName',
  });
  const definitions: IndexDefinition[] = [];
  for (const index of indexRows) {
    const key = objectKey({ owner: index.OWNER, name: index.INDEX_NAME });
    const expressions = expressionGroups.get(key)!;
    uniqueRows(
      expressions,
      ['COLUMN_POSITION'],
      `${index.OWNER}.${index.INDEX_NAME}`,
    );
    const expressionByPosition = new Map(
      expressions.map((row) => [row.COLUMN_POSITION, row.COLUMN_EXPRESSION]),
    );
    const keys = keyGroups.get(key)!;
    orderedRows(keys, 'COLUMN_POSITION', `${index.OWNER}.${index.INDEX_NAME}`);
    for (const position of expressionByPosition.keys()) {
      if (!keys.some((key) => key.COLUMN_POSITION === position)) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          `${index.OWNER}.${index.INDEX_NAME}`,
          'COLUMN_EXPRESSION',
          'Missing or inaccessible index expression key',
        );
      }
    }
    definitions.push({
      reference: { owner: index.OWNER, name: index.INDEX_NAME },
      type: index.INDEX_TYPE,
      unique: index.UNIQUENESS === 'UNIQUE',
      visible: index.VISIBILITY === 'VISIBLE',
      status: index.STATUS,
      partitioned: index.PARTITIONED === 'YES',
      compression: index.COMPRESSION,
      keys: keys.map((key) => ({
        column: expressionByPosition.has(key.COLUMN_POSITION)
          ? null
          : key.COLUMN_NAME,
        expression: expressionByPosition.get(key.COLUMN_POSITION) ?? null,
        direction: key.DESCEND,
      })),
    });
  }
  return definitions;
}
