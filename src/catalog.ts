import { type BindParameters, type Connection } from 'oracledb';
import type { SourceCatalog } from './extract.js';
import {
  qualifiedName,
  objectKey,
  uniqueReferences,
  type ColumnDefinition,
  type ConstraintDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type ObjectReference,
  type Prerequisite,
  type TableDefinition,
  type ViewDefinition,
} from './model.js';

import { z } from 'zod';
import { ExtractionProgress, type QueryCategory } from './progress.js';
import {
  catalogRows,
  catalogFailure,
  uniqueRows,
  orderedRows,
  singleRow,
} from './catalog-decoding.js';

const text = z.string().min(1);
const nullableText = z.string().nullable();
const yn = z.enum(['Y', 'N']);
const yesNo = z.enum(['YES', 'NO']);
const integer = z.number().int().nonnegative();
const tableRow = z.object({
  TABLESPACE_NAME: nullableText,
  COMPRESSION: z.enum(['ENABLED', 'DISABLED']).nullable(),
  IOT_TYPE: z.enum(['IOT', 'IOT_OVERFLOW', 'IOT_MAPPING']).nullable(),
  CLUSTER_NAME: nullableText,
  NESTED: yesNo,
  SECONDARY: yn,
  TEMPORARY: yn,
  PARTITIONED: yesNo,
  ORACLE_MAINTAINED: yn,
  SPECIAL_COUNT: integer,
});
const columnRow = z.object({
  COLUMN_NAME: text,
  COLUMN_ID: integer.positive().nullable(),
  INTERNAL_COLUMN_ID: integer.positive(),
  DATA_TYPE: text,
  DATA_TYPE_OWNER: nullableText,
  DATA_LENGTH: integer,
  CHAR_LENGTH: integer,
  CHAR_USED: z.enum(['C', 'B']).nullable(),
  DATA_PRECISION: z.number().int().nullable(),
  DATA_SCALE: z.number().int().nullable(),
  NULLABLE: yn,
  DATA_DEFAULT: nullableText,
  IDENTITY_COLUMN: yesNo,
  DEFAULT_ON_NULL: yesNo,
  VIRTUAL_COLUMN: yesNo,
  HIDDEN_COLUMN: yesNo,
  COLLATION: nullableText,
});
const commentRow = z.object({ COMMENTS: nullableText });
const columnCommentRow = commentRow.extend({ COLUMN_NAME: text });
const constraintRow = z.object({
  OWNER: text,
  CONSTRAINT_NAME: text,
  CONSTRAINT_TYPE: z.enum(['C', 'P', 'U', 'R', 'V', 'O', 'H', 'F', 'S']),
  GENERATED: z.enum(['USER NAME', 'GENERATED NAME']),
  STATUS: z.enum(['ENABLED', 'DISABLED']),
  VALIDATED: z.enum(['VALIDATED', 'NOT VALIDATED']),
  DEFERRABLE: z.enum(['DEFERRABLE', 'NOT DEFERRABLE']),
  DEFERRED: z.enum(['DEFERRED', 'IMMEDIATE']),
  RELY: z.literal('RELY').nullable(),
  SEARCH_CONDITION: nullableText,
  INDEX_OWNER: nullableText,
  INDEX_NAME: nullableText,
  R_OWNER: nullableText,
  R_CONSTRAINT_NAME: nullableText,
  DELETE_RULE: z.enum(['NO ACTION', 'CASCADE', 'SET NULL']).nullable(),
  PARENT_TABLE_NAME: nullableText,
});
type ConstraintRow = z.infer<typeof constraintRow>;
const indexRow = z.object({
  OWNER: text,
  INDEX_NAME: text,
  INDEX_TYPE: text,
  UNIQUENESS: z.enum(['UNIQUE', 'NONUNIQUE']),
  VISIBILITY: z.enum(['VISIBLE', 'INVISIBLE']),
  STATUS: z.enum(['VALID', 'UNUSABLE', 'N/A']),
  PARTITIONED: yesNo,
  COMPRESSION: z.enum(['ENABLED', 'DISABLED', 'ADVANCED LOW', 'ADVANCED HIGH']),
});
const viewRow = z.object({
  TEXT: text,
  READ_ONLY: yn,
  BEQUEATH: z.enum(['DEFINER', 'CURRENT_USER']),
  EDITIONING_VIEW: yn,
  CONTAINER_DATA: yn,
  DEFAULT_COLLATION: nullableText,
  TYPE_TEXT: nullableText,
  SUPERVIEW_NAME: nullableText,
  STATUS: z.enum(['VALID', 'INVALID']),
  ORACLE_MAINTAINED: yn,
});
const dependencyRow = z.object({
  REFERENCED_OWNER: nullableText,
  REFERENCED_NAME: text,
  REFERENCED_TYPE: text,
  REFERENCED_LINK_NAME: nullableText,
});

export type CatalogScope = 'all' | 'dba';
const catalogViews = {
  constraints: ['all_constraints', 'dba_constraints'],
  consColumns: ['all_cons_columns', 'dba_cons_columns'],
  tables: ['all_tables', 'dba_tables'],
  users: ['all_users', 'dba_users'],
  externalTables: ['all_external_tables', 'dba_external_tables'],
  objectTables: ['all_object_tables', 'dba_object_tables'],
  mviews: ['all_mviews', 'dba_mviews'],
  encryptedColumns: ['all_encrypted_columns', 'dba_encrypted_columns'],
  tabComments: ['all_tab_comments', 'dba_tab_comments'],
  tabIdentityCols: ['all_tab_identity_cols', 'dba_tab_identity_cols'],
  tabCols: ['all_tab_cols', 'dba_tab_cols'],
  colComments: ['all_col_comments', 'dba_col_comments'],
  indexes: ['all_indexes', 'dba_indexes'],
  indExpressions: ['all_ind_expressions', 'dba_ind_expressions'],
  indColumns: ['all_ind_columns', 'dba_ind_columns'],
  views: ['all_views', 'dba_views'],
  objects: ['all_objects', 'dba_objects'],
  tabColumns: ['all_tab_columns', 'dba_tab_columns'],
  dependencies: ['all_dependencies', 'dba_dependencies'],
} as const;
type CatalogView = keyof typeof catalogViews;

export class OracleCatalog implements SourceCatalog {
  private readonly constraintCache = new Map<string, ConstraintRow[]>();
  private readonly constraintColumnCache = new Map<string, string[]>();
  constructor(
    private readonly connection: Connection,
    private readonly scope: CatalogScope = 'all',
    private readonly progress = new ExtractionProgress(),
    private readonly batchSize = 32,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128)
      throw new Error('Catalog batch size must be an integer from 1 to 128.');
  }
  private catalogView(name: CatalogView): string {
    return catalogViews[name][this.scope === 'all' ? 0 : 1];
  }

  private rows<S extends z.ZodTypeAny>(
    queryCategory: QueryCategory,
    schema: S,
    sql: string,
    binds: BindParameters = {},
  ): Promise<z.infer<S>[]> {
    // Only known identifier slots may become object references; never expose binds.
    const named = Array.isArray(binds) ? {} : binds;
    const owner = named.owner;
    const name =
      named.tableName ??
      named.viewName ??
      named.constraintName ??
      named.indexName;
    const object =
      typeof owner === 'string' && typeof name === 'string'
        ? { owner, name }
        : undefined;
    return this.progress.measure(
      'query',
      () => catalogRows(this.connection, schema, sql, binds),
      { queryCategory, ...(object ? { object } : {}) },
      (rows) => rows.length,
    );
  }

  /** Bind exact pairs, never owner/name cross products or interpolated identifiers. */
  private async memberRows<S extends z.ZodTypeAny>(
    references: ObjectReference[],
    category: QueryCategory,
    schema: S,
    view: CatalogView,
    ownerColumn: string,
    nameColumn: string,
    fields: string,
    position: string,
    singleBind: string,
  ): Promise<Map<string, z.infer<S>[]>> {
    const groups = new Map<string, z.infer<S>[]>();
    for (let offset = 0; offset < references.length; offset += this.batchSize) {
      const batch = references.slice(offset, offset + this.batchSize);
      for (const reference of batch) groups.set(objectKey(reference), []);
      if (batch.length === 1) {
        const reference = batch[0];
        groups.set(
          objectKey(reference),
          await this.rows(
            category,
            schema,
            `SELECT ${fields} FROM ${this.catalogView(view)} WHERE ${ownerColumn}=:owner AND ${nameColumn}=:${singleBind} ORDER BY ${position}`,
            { owner: reference.owner, [singleBind]: reference.name },
          ),
        );
        continue;
      }
      const binds: Record<string, string> = {};
      const predicates = batch.map((reference, index) => {
        binds[`owner${index}`] = reference.owner;
        binds[`name${index}`] = reference.name;
        return `(${ownerColumn}=:owner${index} AND ${nameColumn}=:name${index})`;
      });
      const rows = await this.rows(
        category,
        schema.and(z.object({ MEMBER_OWNER: text, MEMBER_NAME: text })),
        `SELECT ${ownerColumn} AS member_owner,${nameColumn} AS member_name,${fields}
         FROM ${this.catalogView(view)} WHERE ${predicates.join(' OR ')}
         ORDER BY ${ownerColumn},${nameColumn},${position}`,
        binds,
      );
      const allowed = new Set(batch.map(objectKey));
      for (const row of rows) {
        const key = objectKey({
          owner: row.MEMBER_OWNER,
          name: row.MEMBER_NAME,
        });
        if (!allowed.has(key))
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            'batch',
            'member',
            'Unexpected member outside selected batch',
          );
        groups.get(key)!.push(row);
      }
    }
    return groups;
  }

  private async prefetchConstraintColumns(
    rows: ConstraintRow[],
  ): Promise<void> {
    const references = uniqueReferences(
      rows.flatMap((row) => {
        if (!['P', 'U', 'R'].includes(row.CONSTRAINT_TYPE)) return [];
        return [
          { owner: row.OWNER, name: row.CONSTRAINT_NAME },
          ...(row.CONSTRAINT_TYPE === 'R' &&
          row.R_OWNER &&
          row.R_CONSTRAINT_NAME
            ? [{ owner: row.R_OWNER, name: row.R_CONSTRAINT_NAME }]
            : []),
        ];
      }),
    ).filter(
      (reference) => !this.constraintColumnCache.has(objectKey(reference)),
    );
    const groups = await this.memberRows(
      references,
      'constraint-columns',
      z.object({ COLUMN_NAME: text, POSITION: integer.positive() }),
      'consColumns',
      'owner',
      'constraint_name',
      'column_name,position',
      'position',
      'constraintName',
    );
    for (const reference of references) {
      const members = groups.get(objectKey(reference))!;
      orderedRows(members, 'POSITION', qualifiedName(reference));
      uniqueRows(members, ['COLUMN_NAME'], qualifiedName(reference));
    }
    // Publish only after every member of the requested set has passed validation.
    for (const [key, members] of groups)
      this.constraintColumnCache.set(
        key,
        members.map((row) => row.COLUMN_NAME),
      );
  }

  async databaseVersion(): Promise<string> {
    const rows = await this.rows(
      'database-version',
      z.object({ VERSION: text }),
      "SELECT version FROM product_component_version WHERE product LIKE 'Oracle%Database%' ORDER BY product",
    );
    return singleRow(rows, 'database', 'VERSION').VERSION;
  }

  private async constraintRows(
    table: ObjectReference,
  ): Promise<ConstraintRow[]> {
    const cacheKey = objectKey(table);
    const cached = this.constraintCache.get(cacheKey);
    if (cached) return cached;
    // Read the LONG SEARCH_CONDITION itself. SEARCH_CONDITION_VC can truncate.
    const rows = await this.rows(
      'constraints',
      constraintRow,
      `
      SELECT c.owner,c.constraint_name,c.constraint_type,c.generated,c.status,c.validated,
             c.deferrable,c.deferred,c.rely,c.search_condition,c.index_owner,c.index_name,
             c.r_owner,c.r_constraint_name,c.delete_rule,p.table_name AS parent_table_name
        FROM ${this.catalogView('constraints')} c
        LEFT JOIN ${this.catalogView('constraints')} p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
       WHERE c.owner=:owner AND c.table_name=:tableName ORDER BY c.constraint_name`,
      { owner: table.owner, tableName: table.name },
    );
    uniqueRows(rows, ['OWNER', 'CONSTRAINT_NAME'], qualifiedName(table));
    await this.prefetchConstraintColumns(rows);
    this.constraintCache.set(cacheKey, rows);
    return rows;
  }

  private async constraintColumns(
    reference: ObjectReference,
  ): Promise<string[]> {
    const cacheKey = objectKey(reference);
    const cached = this.constraintColumnCache.get(cacheKey);
    if (cached) return cached;
    const rows = await this.rows(
      'constraint-columns',
      z.object({ COLUMN_NAME: text, POSITION: integer.positive() }),
      `
      SELECT column_name,position FROM ${this.catalogView('consColumns')}
       WHERE owner=:owner AND constraint_name=:constraintName ORDER BY position`,
      { owner: reference.owner, constraintName: reference.name },
    );
    orderedRows(rows, 'POSITION', qualifiedName(reference));
    uniqueRows(rows, ['COLUMN_NAME'], qualifiedName(reference));
    const columns = rows.map((row) => row.COLUMN_NAME);
    this.constraintColumnCache.set(cacheKey, columns);
    return columns;
  }

  private constraintProperties(row: ConstraintRow) {
    return {
      name: row.CONSTRAINT_NAME,
      generatedName: row.GENERATED === 'GENERATED NAME',
      state: {
        enabled: row.STATUS === 'ENABLED',
        validated: row.VALIDATED === 'VALIDATED',
        deferrable: row.DEFERRABLE === 'DEFERRABLE',
        initiallyDeferred: row.DEFERRED === 'DEFERRED',
        rely: row.RELY === 'RELY',
      },
    };
  }

  private async foreignKey(row: ConstraintRow): Promise<ForeignKeyDefinition> {
    if (!row.R_OWNER || !row.R_CONSTRAINT_NAME || !row.PARENT_TABLE_NAME) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        `${row.OWNER}.${row.CONSTRAINT_NAME}`,
        'R_CONSTRAINT_NAME',
        'Cannot resolve parent metadata',
      );
    }
    const childColumns = await this.constraintColumns({
      owner: row.OWNER,
      name: row.CONSTRAINT_NAME,
    });
    const parentConstraint = {
      owner: row.R_OWNER,
      name: row.R_CONSTRAINT_NAME,
    };
    const parentColumns = await this.constraintColumns(parentConstraint);
    if (!childColumns.length || childColumns.length !== parentColumns.length)
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        `${row.OWNER}.${row.CONSTRAINT_NAME}`,
        'columnPairs',
        'Incomplete composite FK metadata',
      );
    return {
      ...this.constraintProperties(row),
      kind: 'foreign-key',
      parentConstraint,
      parentTable: { owner: row.R_OWNER, name: row.PARENT_TABLE_NAME },
      onDelete:
        row.DELETE_RULE ??
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          `${row.OWNER}.${row.CONSTRAINT_NAME}`,
          'DELETE_RULE',
        ),
      columnPairs: childColumns.map((childColumn, position) => ({
        childColumn,
        parentColumn: parentColumns[position],
      })),
    };
  }
  async foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]> {
    const definitions: ForeignKeyDefinition[] = [];
    for (const row of await this.constraintRows(table))
      if (row.CONSTRAINT_TYPE === 'R')
        definitions.push(await this.foreignKey(row));
    return definitions;
  }

  async table(reference: ObjectReference): Promise<TableDefinition> {
    const binds = { owner: reference.owner, tableName: reference.name };
    const rows = await this.rows(
      'table',
      tableRow,
      `
      SELECT t.tablespace_name,t.compression,t.iot_type,t.cluster_name,t.nested,t.secondary,
             t.temporary,t.partitioned,u.oracle_maintained,
             (SELECT COUNT(*) FROM ${this.catalogView('externalTables')} e WHERE e.owner=t.owner AND e.table_name=t.table_name)
           + (SELECT COUNT(*) FROM ${this.catalogView('objectTables')} o WHERE o.owner=t.owner AND o.table_name=t.table_name)
           + (SELECT COUNT(*) FROM ${this.catalogView('mviews')} m WHERE m.owner=t.owner AND m.mview_name=t.table_name)
           + (SELECT COUNT(*) FROM ${this.catalogView('encryptedColumns')} e WHERE e.owner=t.owner AND e.table_name=t.table_name) AS special_count
        FROM ${this.catalogView('tables')} t JOIN ${this.catalogView('users')} u ON u.username=t.owner
       WHERE t.owner=:owner AND t.table_name=:tableName`,
      binds,
    );
    const table = singleRow(rows, qualifiedName(reference), 'table');
    const tableComments = await this.rows(
      'table-comments',
      commentRow,
      `
      SELECT comments FROM ${this.catalogView('tabComments')}
       WHERE owner=:owner AND table_name=:tableName AND table_type='TABLE'`,
      binds,
    );
    singleRow(tableComments, qualifiedName(reference), 'COMMENTS');
    const unsupportedFeatures: string[] = [];
    if (table.IOT_TYPE)
      unsupportedFeatures.push(`Index-organized table: ${table.IOT_TYPE}`);
    if (table.CLUSTER_NAME)
      unsupportedFeatures.push(`Cluster: ${table.CLUSTER_NAME}`);
    if (table.NESTED !== 'NO' || table.SECONDARY !== 'N')
      unsupportedFeatures.push('Nested or secondary storage table');
    if (table.TEMPORARY !== 'N') unsupportedFeatures.push('Temporary table');
    if (table.PARTITIONED !== 'NO')
      unsupportedFeatures.push('Partitioned table');
    if (table.ORACLE_MAINTAINED !== 'N')
      unsupportedFeatures.push('Oracle-maintained schema');
    if (table.SPECIAL_COUNT)
      unsupportedFeatures.push(
        'External/object/materialized-view table or encrypted column',
      );

    const identities = await this.rows(
      'identities',
      z.object({
        COLUMN_NAME: text,
        GENERATION_TYPE: z.enum(['ALWAYS', 'BY DEFAULT', 'BY DEFAULT ON NULL']),
        IDENTITY_OPTIONS: text,
      }),
      `SELECT column_name,generation_type,identity_options FROM ${this.catalogView('tabIdentityCols')} WHERE owner=:owner AND table_name=:tableName`,
      binds,
    );
    uniqueRows(identities, ['COLUMN_NAME'], qualifiedName(reference));
    const identityByColumn = new Map(
      identities.map((row) => [row.COLUMN_NAME, row]),
    );
    // USER_GENERATED retains invisible user columns but excludes internal columns
    // backing function-based indexes. Those indexes are modeled as expressions.
    const columnRows = await this.rows(
      'columns',
      columnRow,
      `
      SELECT column_name,column_id,internal_column_id,data_type,data_type_owner,data_length,char_length,
             char_used,data_precision,data_scale,nullable,data_default,identity_column,default_on_null,virtual_column,hidden_column,collation
        FROM ${this.catalogView('tabCols')} WHERE owner=:owner AND table_name=:tableName AND user_generated='YES'
       ORDER BY column_id NULLS LAST, internal_column_id`,
      binds,
    );
    const columnCommentRows = await this.rows(
      'column-comments',
      columnCommentRow,
      `
      SELECT cc.column_name,cc.comments
        FROM ${this.catalogView('colComments')} cc
        JOIN ${this.catalogView('tabCols')} tc ON tc.owner=cc.owner AND tc.table_name=cc.table_name AND tc.column_name=cc.column_name
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
    for (const column of columnRows)
      if (
        (column.IDENTITY_COLUMN === 'YES') !==
        identityByColumn.has(column.COLUMN_NAME)
      )
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          qualifiedName(reference) + '.' + column.COLUMN_NAME,
          'IDENTITY_COLUMN',
        );
    if (!columnRows.length)
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference),
        'columns',
      );
    const commentByColumn = new Map<string, string | null>();
    for (const row of columnCommentRows) {
      if (commentByColumn.has(row.COLUMN_NAME))
        catalogFailure(
          'CATALOG_CARDINALITY',
          qualifiedName(reference) + '.' + row.COLUMN_NAME,
          'COMMENTS',
          'Duplicate column comment row',
        );
      commentByColumn.set(row.COLUMN_NAME, row.COMMENTS);
    }
    const modeledNames = new Set(columnRows.map((row) => row.COLUMN_NAME));
    for (const name of identityByColumn.keys())
      if (!modeledNames.has(name)) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          qualifiedName(reference) + '.' + name,
          'identity',
          'Missing or inaccessible identity column metadata',
        );
      }
    for (const name of commentByColumn.keys())
      if (!modeledNames.has(name)) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          qualifiedName(reference) + '.' + name,
          'COMMENTS',
          'Unexpected column comment row',
        );
      }
    for (const name of modeledNames)
      if (!commentByColumn.has(name)) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          qualifiedName(reference) + '.' + name,
          'COMMENTS',
          'Missing column comment row',
        );
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
    const constraints: ConstraintDefinition[] = [];
    for (const row of await this.constraintRows(reference)) {
      if ((row.INDEX_OWNER === null) !== (row.INDEX_NAME === null))
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          `${row.OWNER}.${row.CONSTRAINT_NAME}`,
          'INDEX_OWNER,INDEX_NAME',
        );
      const properties = this.constraintProperties(row);
      if (row.CONSTRAINT_TYPE === 'R')
        constraints.push(await this.foreignKey(row));
      else if (row.CONSTRAINT_TYPE === 'P' || row.CONSTRAINT_TYPE === 'U') {
        const constraintColumns = await this.constraintColumns({
          owner: row.OWNER,
          name: row.CONSTRAINT_NAME,
        });
        if (!constraintColumns.length)
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            `${row.OWNER}.${row.CONSTRAINT_NAME}`,
            'columns',
            'Missing or inaccessible constraint columns',
          );
        constraints.push({
          ...properties,
          kind: row.CONSTRAINT_TYPE === 'P' ? 'primary-key' : 'unique',
          columns: constraintColumns,
          backingIndex:
            row.INDEX_OWNER && row.INDEX_NAME
              ? { owner: row.INDEX_OWNER, name: row.INDEX_NAME }
              : null,
        });
      } else if (row.CONSTRAINT_TYPE === 'C') {
        if (!row.SEARCH_CONDITION)
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            `${row.OWNER}.${row.CONSTRAINT_NAME}`,
            'SEARCH_CONDITION',
            'Missing full check expression',
          );
        // Oracle represents NOT NULL in the catalog as a check predicate. Only
        // recognize the exact canonical form; never parse arbitrary predicates.
        const notNull = /^\s*"((?:[^"]|"")+)"\s+IS\s+NOT\s+NULL\s*$/i.exec(
          row.SEARCH_CONDITION,
        );
        const columnName = notNull?.[1].replaceAll('""', '"');
        if (
          columnName &&
          columns.some((column) => column.name === columnName)
        ) {
          constraints.push({
            ...properties,
            kind: 'not-null',
            column: columnName,
          });
        } else
          constraints.push({
            ...properties,
            kind: 'check',
            expression: row.SEARCH_CONDITION,
          });
      } else
        unsupportedFeatures.push(
          `Constraint ${row.CONSTRAINT_NAME} has unsupported type ${row.CONSTRAINT_TYPE}`,
        );
    }
    return {
      reference,
      role: 'target',
      comment: tableComments[0].COMMENTS,
      unsupportedFeatures,
      sourcePhysical: {
        tablespace: table.TABLESPACE_NAME,
        compression: table.COMPRESSION,
      },
      columns,
      constraints,
      indexes: await this.indexes(reference),
    };
  }

  private async indexes(table: ObjectReference): Promise<IndexDefinition[]> {
    const indexRows = await this.rows(
      'indexes',
      indexRow,
      `
      SELECT owner,index_name,index_type,uniqueness,visibility,status,partitioned,compression
        FROM ${this.catalogView('indexes')} WHERE table_owner=:owner AND table_name=:tableName AND index_type<>'LOB'
       ORDER BY owner,index_name`,
      { owner: table.owner, tableName: table.name },
    );
    uniqueRows(indexRows, ['OWNER', 'INDEX_NAME'], qualifiedName(table));
    const references = indexRows.map((index) => ({
      owner: index.OWNER,
      name: index.INDEX_NAME,
    }));
    const expressionGroups = await this.memberRows(
      references,
      'index-expressions',
      z.object({
        COLUMN_POSITION: integer.positive(),
        COLUMN_EXPRESSION: text,
      }),
      'indExpressions',
      'index_owner',
      'index_name',
      'column_position,column_expression',
      'column_position',
      'indexName',
    );
    const keyGroups = await this.memberRows(
      references,
      'index-columns',
      z.object({
        COLUMN_NAME: text,
        COLUMN_POSITION: integer.positive(),
        DESCEND: z.enum(['ASC', 'DESC']),
      }),
      'indColumns',
      'index_owner',
      'index_name',
      'column_name,column_position,descend',
      'column_position',
      'indexName',
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
      orderedRows(
        keys,
        'COLUMN_POSITION',
        `${index.OWNER}.${index.INDEX_NAME}`,
      );
      for (const position of expressionByPosition.keys())
        if (!keys.some((key) => key.COLUMN_POSITION === position)) {
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            `${index.OWNER}.${index.INDEX_NAME}`,
            'COLUMN_EXPRESSION',
            'Missing or inaccessible index expression key',
          );
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

  async view(reference: ObjectReference): Promise<ViewDefinition> {
    const binds = { owner: reference.owner, viewName: reference.name };
    const rows = await this.rows(
      'view',
      viewRow,
      `SELECT v.text,v.read_only,v.bequeath,v.editioning_view,v.container_data,v.default_collation,v.type_text,v.superview_name,o.status,u.oracle_maintained FROM ${this.catalogView('views')} v JOIN ${this.catalogView('objects')} o ON o.owner=v.owner AND o.object_name=v.view_name AND o.object_type='VIEW' JOIN ${this.catalogView('users')} u ON u.username=v.owner WHERE v.owner=:owner AND v.view_name=:viewName`,
      binds,
    );
    const row = singleRow(rows, qualifiedName(reference), 'view');
    const columns = await this.rows(
      'view-columns',
      z.object({ COLUMN_NAME: text, POSITION: integer.positive() }),
      `SELECT column_name,column_id AS position FROM ${this.catalogView('tabColumns')} WHERE owner=:owner AND table_name=:viewName ORDER BY column_id`,
      binds,
    );
    orderedRows(columns, 'POSITION', qualifiedName(reference));
    uniqueRows(columns, ['COLUMN_NAME'], qualifiedName(reference));
    const restrictions = await this.rows(
      'view-restrictions',
      z.object({
        CONSTRAINT_NAME: text,
        CONSTRAINT_TYPE: z.enum(['V', 'O']),
        STATUS: z.literal('ENABLED'),
      }),
      `SELECT constraint_name,constraint_type,status FROM ${this.catalogView('constraints')}
      WHERE owner=:owner AND table_name=:viewName AND constraint_type IN ('V','O')`,
      binds,
    );
    if (restrictions.length > 1)
      catalogFailure(
        'CATALOG_CARDINALITY',
        qualifiedName(reference),
        'restrictions',
      );
    const readOnly = row.READ_ONLY === 'Y';
    if (readOnly !== (restrictions[0]?.CONSTRAINT_TYPE === 'O'))
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference),
        'READ_ONLY',
        'Restriction metadata disagrees',
      );
    const unsupportedFeatures: string[] = [];
    if (row.ORACLE_MAINTAINED !== 'N')
      unsupportedFeatures.push('Oracle-maintained schema');
    if (row.EDITIONING_VIEW === 'Y')
      unsupportedFeatures.push('Editioning view');
    if (row.TYPE_TEXT || row.SUPERVIEW_NAME)
      unsupportedFeatures.push('Typed or superview');
    if (row.CONTAINER_DATA === 'Y')
      unsupportedFeatures.push('Container-data view');
    return {
      reference,
      role: 'target',
      columns: columns.map((column) => column.COLUMN_NAME),
      query: row.TEXT,
      readOnly,
      checkOption:
        restrictions[0]?.CONSTRAINT_TYPE === 'V' ? 'CASCADED' : 'NONE',
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

  async viewDependencies(
    reference: ObjectReference,
  ): Promise<ViewDefinition['dependencies']> {
    const rows = await this.rows(
      'view-dependencies',
      dependencyRow,
      `SELECT DISTINCT referenced_owner,referenced_name,referenced_type,referenced_link_name FROM ${this.catalogView('dependencies')} WHERE owner=:owner AND name=:viewName AND type='VIEW' ORDER BY referenced_owner,referenced_name,referenced_type`,
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

  async prerequisites(table: ObjectReference): Promise<Prerequisite[]> {
    const rows = await this.rows(
      'prerequisites',
      dependencyRow,
      `
      SELECT DISTINCT d.referenced_owner,d.referenced_name,d.referenced_type,d.referenced_link_name
        FROM ${this.catalogView('dependencies')} d
       WHERE ((d.owner=:owner AND d.name=:tableName AND d.type='TABLE') OR
         (d.type='INDEX' AND EXISTS (SELECT 1 FROM ${this.catalogView('indexes')} i WHERE i.owner=d.owner AND i.index_name=d.name
           AND i.table_owner=:owner AND i.table_name=:tableName)))
         AND (d.referenced_link_name IS NOT NULL OR
           (d.referenced_type<>'TABLE' AND NOT EXISTS (SELECT 1 FROM ${this.catalogView('users')} u
             WHERE u.username=d.referenced_owner AND u.oracle_maintained='Y')))
         AND NOT EXISTS (SELECT 1 FROM ${this.catalogView('tabIdentityCols')} identity_column
           WHERE identity_column.owner=d.referenced_owner AND identity_column.sequence_name=d.referenced_name
             AND d.referenced_type='SEQUENCE')
       ORDER BY d.referenced_owner,d.referenced_name`,
      { owner: table.owner, tableName: table.name },
    );
    uniqueRows(
      rows,
      [
        'REFERENCED_OWNER',
        'REFERENCED_NAME',
        'REFERENCED_TYPE',
        'REFERENCED_LINK_NAME',
      ],
      qualifiedName(table),
    );
    return rows.map((row) => ({
      requiredBy: table,
      reference: {
        owner: row.REFERENCED_OWNER ?? 'PUBLIC',
        name: row.REFERENCED_NAME,
      },
      type: row.REFERENCED_TYPE,
      databaseLink: row.REFERENCED_LINK_NAME,
    }));
  }
}
