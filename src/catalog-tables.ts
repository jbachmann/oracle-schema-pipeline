/**
 * Assembles source table definitions from Oracle catalog rows: physical facts,
 * comments, columns, identities, constraints, and index keys or expressions.
 * Cross-row checks reject incomplete or inconsistent metadata before returning a
 * definition, while unsupported table features are recorded for later validation.
 * Queries use the adapter's shared reader, and constraint assembly uses its shared
 * constraint reader so dependency discovery and table reads reuse the same cache.
 */
import { catalogQueries } from './catalog-queries.js';
import type { CatalogReader, MemberQuery } from './catalog-reader.js';
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
  indexExpressionRowSchema,
  indexColumnRowSchema,
} from './catalog-schemas.js';

export async function readTable(
  reader: CatalogReader,
  constraintReader: ConstraintReader,
  reference: ObjectReference,
): Promise<TableDefinition> {
  const binds = { owner: reference.owner, tableName: reference.name };
  const rows = await reader.read(catalogQueries(reader)['table'], binds);
  const table = singleRow(rows, qualifiedName(reference), 'table');
  const tableComments = await reader.read(
    catalogQueries(reader)['table-comments'],
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
  const identities = await reader.read(
    catalogQueries(reader)['identities'],
    binds,
  );
  uniqueRows(identities, ['COLUMN_NAME'], qualifiedName(reference));
  const identityByColumn = new Map(
    identities.map((row) => [row.COLUMN_NAME, row]),
  );
  // USER_GENERATED retains invisible user columns but excludes internal columns
  // backing function-based indexes. Those indexes are modeled as expressions.
  const columnRows = await reader.read(
    catalogQueries(reader)['columns'],
    binds,
  );
  const columnCommentRows = await reader.read(
    catalogQueries(reader)['column-comments'],
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
  const indexRows = await reader.read(catalogQueries(reader)['indexes'], {
    owner: table.owner,
    tableName: table.name,
  });
  uniqueRows(indexRows, ['OWNER', 'INDEX_NAME'], qualifiedName(table));
  const references = indexRows.map((index) => ({
    owner: index.OWNER,
    name: index.INDEX_NAME,
  }));
  const expressionGroups = await reader.memberRows(
    references,
    indexMemberQueries.expressions,
  );
  const keyGroups = await reader.memberRows(
    references,
    indexMemberQueries.columns,
  );
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
      dependencies: await readIndexDependencies(
        reader,
        {
          owner: index.OWNER,
          name: index.INDEX_NAME,
        },
        table,
      ),
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

async function readIndexDependencies(
  reader: CatalogReader,
  reference: ObjectReference,
  table: ObjectReference,
): Promise<IndexDefinition['dependencies']> {
  const rows = await reader.read(catalogQueries(reader)['index-dependencies'], {
    owner: reference.owner,
    indexName: reference.name,
    tableOwner: table.owner,
    tableName: table.name,
  });
  const dependencies = rows.map((row) => {
    if (row.REFERENCED_OWNER === null) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference),
        'REFERENCED_OWNER',
      );
    }
    return {
      reference: { owner: row.REFERENCED_OWNER!, name: row.REFERENCED_NAME },
      type: row.REFERENCED_TYPE,
      databaseLink: row.REFERENCED_LINK_NAME,
    };
  });
  return [
    ...new Map(
      dependencies.map((edge) => [JSON.stringify(edge), edge]),
    ).entries(),
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, edge]) => edge);
}

export const indexMemberQueries = {
  expressions: {
    category: 'index-expressions',
    schema: indexExpressionRowSchema,
    view: 'indExpressions',
    ownerColumn: 'index_owner',
    nameColumn: 'index_name',
    fields: 'column_position,column_expression',
    position: 'column_position',
    singleBind: 'indexName',
  },
  columns: {
    category: 'index-columns',
    schema: indexColumnRowSchema,
    view: 'indColumns',
    ownerColumn: 'index_owner',
    nameColumn: 'index_name',
    fields: 'column_name,column_position,descend',
    position: 'column_position',
    singleBind: 'indexName',
  },
} satisfies Record<string, MemberQuery>;
