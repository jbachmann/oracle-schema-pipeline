import oracle, { type BindParameters, type Connection } from 'oracledb';
import type { SourceCatalog } from './extract.js';
import { qualifiedName, objectKey, type ColumnDefinition, type ConstraintDefinition, type ForeignKeyDefinition,
  type IndexDefinition, type ObjectReference, type Prerequisite, type TableDefinition } from './model.js';

interface TableRow {
  TABLESPACE_NAME: string | null; COMPRESSION: string | null; IOT_TYPE: string | null;
  CLUSTER_NAME: string | null; NESTED: string; SECONDARY: string; TEMPORARY: string;
  PARTITIONED: string; ORACLE_MAINTAINED: string; SPECIAL_COUNT: number;
}
interface ColumnRow {
  COLUMN_NAME: string; COLUMN_ID: number | null; INTERNAL_COLUMN_ID: number;
  DATA_TYPE: string; DATA_TYPE_OWNER: string | null; DATA_LENGTH: number;
  CHAR_LENGTH: number; CHAR_USED: string | null; DATA_PRECISION: number | null; DATA_SCALE: number | null;
  NULLABLE: string; DATA_DEFAULT: string | null; DEFAULT_ON_NULL: string;
  VIRTUAL_COLUMN: string; HIDDEN_COLUMN: string; COLLATION: string | null;
}
interface ConstraintRow {
  OWNER: string; CONSTRAINT_NAME: string; CONSTRAINT_TYPE: string; GENERATED: string;
  STATUS: string; VALIDATED: string; DEFERRABLE: string; DEFERRED: string; RELY: string | null;
  SEARCH_CONDITION: string | null; INDEX_OWNER: string | null; INDEX_NAME: string | null;
  R_OWNER: string | null; R_CONSTRAINT_NAME: string | null; DELETE_RULE: 'NO ACTION' | 'CASCADE' | 'SET NULL';
  PARENT_TABLE_NAME: string | null;
}
interface IndexRow {
  OWNER: string; INDEX_NAME: string; INDEX_TYPE: string; UNIQUENESS: string;
  VISIBILITY: string; STATUS: string; PARTITIONED: string; COMPRESSION: string;
}

/** Dictionary reads are complete result-set reads, never limited by maxRows. */
async function queryRows<Row>(connection: Connection, sql: string, binds: BindParameters = {}): Promise<Row[]> {
  const result = await connection.execute<Row>(sql, binds, { outFormat: oracle.OUT_FORMAT_OBJECT, resultSet: true });
  const resultSet = result.resultSet!;
  const rows: Row[] = [];
  try {
    while (true) {
      const batch = await resultSet.getRows(100);
      if (!batch.length) return rows;
      rows.push(...batch);
    }
  } finally { await resultSet.close(); }
}

export class OracleCatalog implements SourceCatalog {
  private readonly constraintCache = new Map<string, ConstraintRow[]>();
  private readonly constraintColumnCache = new Map<string, string[]>();
  constructor(private readonly connection: Connection) {}

  async databaseVersion(): Promise<string> {
    const rows = await queryRows<{ VERSION: string }>(this.connection,
      "SELECT version FROM product_component_version WHERE product LIKE 'Oracle Database%' ORDER BY product");
    return rows[0]?.VERSION ?? 'unknown';
  }

  private async constraintRows(table: ObjectReference): Promise<ConstraintRow[]> {
    const cacheKey = objectKey(table);
    const cached = this.constraintCache.get(cacheKey);
    if (cached) return cached;
    // Read the LONG SEARCH_CONDITION itself. SEARCH_CONDITION_VC can truncate.
    const rows = await queryRows<ConstraintRow>(this.connection, `
      SELECT c.owner,c.constraint_name,c.constraint_type,c.generated,c.status,c.validated,
             c.deferrable,c.deferred,c.rely,c.search_condition,c.index_owner,c.index_name,
             c.r_owner,c.r_constraint_name,c.delete_rule,p.table_name AS parent_table_name
        FROM dba_constraints c
        LEFT JOIN dba_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
       WHERE c.owner=:owner AND c.table_name=:tableName ORDER BY c.constraint_name`,
      { owner: table.owner, tableName: table.name });
    this.constraintCache.set(cacheKey, rows);
    return rows;
  }

  private async constraintColumns(reference: ObjectReference): Promise<string[]> {
    const cacheKey = objectKey(reference);
    const cached = this.constraintColumnCache.get(cacheKey);
    if (cached) return cached;
    const rows = await queryRows<{ COLUMN_NAME: string }>(this.connection, `
      SELECT column_name FROM dba_cons_columns
       WHERE owner=:owner AND constraint_name=:constraintName ORDER BY position`,
      { owner: reference.owner, constraintName: reference.name });
    const columns = rows.map(row => row.COLUMN_NAME);
    this.constraintColumnCache.set(cacheKey, columns);
    return columns;
  }

  private constraintProperties(row: ConstraintRow) {
    return {
      name: row.CONSTRAINT_NAME, generatedName: row.GENERATED === 'GENERATED NAME',
      state: { enabled: row.STATUS === 'ENABLED', validated: row.VALIDATED === 'VALIDATED',
        deferrable: row.DEFERRABLE === 'DEFERRABLE', initiallyDeferred: row.DEFERRED === 'DEFERRED', rely: row.RELY === 'RELY' },
    };
  }

  private async foreignKey(row: ConstraintRow): Promise<ForeignKeyDefinition> {
    if (!row.R_OWNER || !row.R_CONSTRAINT_NAME || !row.PARENT_TABLE_NAME) {
      throw new Error(`Cannot resolve parent metadata for ${row.OWNER}.${row.CONSTRAINT_NAME}.`);
    }
    const childColumns = await this.constraintColumns({ owner: row.OWNER, name: row.CONSTRAINT_NAME });
    const parentConstraint = { owner: row.R_OWNER, name: row.R_CONSTRAINT_NAME };
    const parentColumns = await this.constraintColumns(parentConstraint);
    if (!childColumns.length || childColumns.length !== parentColumns.length) throw new Error(`Incomplete composite FK metadata: ${row.CONSTRAINT_NAME}.`);
    return {
      ...this.constraintProperties(row), kind: 'foreign-key', parentConstraint,
      parentTable: { owner: row.R_OWNER, name: row.PARENT_TABLE_NAME }, onDelete: row.DELETE_RULE,
      columnPairs: childColumns.map((childColumn, position) => ({ childColumn, parentColumn: parentColumns[position] })),
    };
  }
  async foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]> {
    const definitions: ForeignKeyDefinition[] = [];
    for (const row of await this.constraintRows(table)) if (row.CONSTRAINT_TYPE === 'R') definitions.push(await this.foreignKey(row));
    return definitions;
  }

  async table(reference: ObjectReference): Promise<TableDefinition> {
    const binds = { owner: reference.owner, tableName: reference.name };
    const rows = await queryRows<TableRow>(this.connection, `
      SELECT t.tablespace_name,t.compression,t.iot_type,t.cluster_name,t.nested,t.secondary,
             t.temporary,t.partitioned,u.oracle_maintained,
             (SELECT COUNT(*) FROM dba_external_tables e WHERE e.owner=t.owner AND e.table_name=t.table_name)
           + (SELECT COUNT(*) FROM dba_object_tables o WHERE o.owner=t.owner AND o.table_name=t.table_name)
           + (SELECT COUNT(*) FROM dba_mviews m WHERE m.owner=t.owner AND m.mview_name=t.table_name)
           + (SELECT COUNT(*) FROM dba_encrypted_columns e WHERE e.owner=t.owner AND e.table_name=t.table_name) AS special_count
        FROM dba_tables t JOIN dba_users u ON u.username=t.owner
       WHERE t.owner=:owner AND t.table_name=:tableName`, binds);
    const table = rows[0];
    if (!table) throw new Error(`Missing or inaccessible table: ${qualifiedName(reference)}.`);
    const unsupportedFeatures: string[] = [];
    if (table.IOT_TYPE) unsupportedFeatures.push(`Index-organized table: ${table.IOT_TYPE}`);
    if (table.CLUSTER_NAME) unsupportedFeatures.push(`Cluster: ${table.CLUSTER_NAME}`);
    if (table.NESTED !== 'NO' || table.SECONDARY !== 'N') unsupportedFeatures.push('Nested or secondary storage table');
    if (table.TEMPORARY !== 'N') unsupportedFeatures.push('Temporary table');
    if (table.PARTITIONED !== 'NO') unsupportedFeatures.push('Partitioned table');
    if (table.ORACLE_MAINTAINED !== 'N') unsupportedFeatures.push('Oracle-maintained schema');
    if (table.SPECIAL_COUNT) unsupportedFeatures.push('External/object/materialized-view table or encrypted column');

    const identities = await queryRows<{ COLUMN_NAME: string; GENERATION_TYPE: string; IDENTITY_OPTIONS: string }>(this.connection,
      'SELECT column_name,generation_type,identity_options FROM dba_tab_identity_cols WHERE owner=:owner AND table_name=:tableName', binds);
    const identityByColumn = new Map(identities.map(row => [row.COLUMN_NAME, row]));
    // USER_GENERATED retains invisible user columns but excludes internal columns
    // backing function-based indexes. Those indexes are modeled as expressions.
    const columnRows = await queryRows<ColumnRow>(this.connection, `
      SELECT column_name,column_id,internal_column_id,data_type,data_type_owner,data_length,char_length,
             char_used,data_precision,data_scale,nullable,data_default,default_on_null,virtual_column,hidden_column,collation
        FROM dba_tab_cols WHERE owner=:owner AND table_name=:tableName AND user_generated='YES'
       ORDER BY column_id NULLS LAST, internal_column_id`, binds);
    const columns: ColumnDefinition[] = columnRows.map((column, position) => {
      const identity = identityByColumn.get(column.COLUMN_NAME);
      return {
        name: column.COLUMN_NAME, position: position + 1,
        dataType: { name: column.DATA_TYPE, owner: column.DATA_TYPE_OWNER, byteLength: column.DATA_LENGTH,
          characterLength: column.CHAR_LENGTH ?? 0, lengthSemantics: column.CHAR_USED === 'C' ? 'CHAR' : column.CHAR_USED === 'B' ? 'BYTE' : null,
          precision: column.DATA_PRECISION, scale: column.DATA_SCALE },
        nullable: column.NULLABLE === 'Y', defaultExpression: column.DATA_DEFAULT,
        defaultOnNull: column.DEFAULT_ON_NULL === 'YES', virtual: column.VIRTUAL_COLUMN === 'YES',
        invisible: column.HIDDEN_COLUMN === 'YES', collation: column.COLLATION,
        identity: identity ? { generation: identity.GENERATION_TYPE, options: identity.IDENTITY_OPTIONS } : null,
      };
    });
    const constraints: ConstraintDefinition[] = [];
    for (const row of await this.constraintRows(reference)) {
      const properties = this.constraintProperties(row);
      if (row.CONSTRAINT_TYPE === 'R') constraints.push(await this.foreignKey(row));
      else if (row.CONSTRAINT_TYPE === 'P' || row.CONSTRAINT_TYPE === 'U') {
        constraints.push({ ...properties, kind: row.CONSTRAINT_TYPE === 'P' ? 'primary-key' : 'unique',
          columns: await this.constraintColumns({ owner: row.OWNER, name: row.CONSTRAINT_NAME }),
          backingIndex: row.INDEX_OWNER && row.INDEX_NAME ? { owner: row.INDEX_OWNER, name: row.INDEX_NAME } : null });
      } else if (row.CONSTRAINT_TYPE === 'C') {
        if (!row.SEARCH_CONDITION) throw new Error(`Missing full check expression: ${row.CONSTRAINT_NAME}.`);
        // Oracle represents NOT NULL in the catalog as a check predicate. Only
        // recognize the exact canonical form; never parse arbitrary predicates.
        const notNull = /^\s*"((?:[^"]|"")+)"\s+IS\s+NOT\s+NULL\s*$/i.exec(row.SEARCH_CONDITION);
        const columnName = notNull?.[1].replaceAll('""', '"');
        if (columnName && columns.some(column => column.name === columnName)) {
          constraints.push({ ...properties, kind: 'not-null', column: columnName });
        } else constraints.push({ ...properties, kind: 'check', expression: row.SEARCH_CONDITION });
      } else unsupportedFeatures.push(`Constraint ${row.CONSTRAINT_NAME} has unsupported type ${row.CONSTRAINT_TYPE}`);
    }
    return { reference, role: 'target', unsupportedFeatures,
      sourcePhysical: { tablespace: table.TABLESPACE_NAME, compression: table.COMPRESSION },
      columns, constraints, indexes: await this.indexes(reference) };
  }

  private async indexes(table: ObjectReference): Promise<IndexDefinition[]> {
    const indexRows = await queryRows<IndexRow>(this.connection, `
      SELECT owner,index_name,index_type,uniqueness,visibility,status,partitioned,compression
        FROM dba_indexes WHERE table_owner=:owner AND table_name=:tableName AND index_type<>'LOB'
       ORDER BY owner,index_name`, { owner: table.owner, tableName: table.name });
    const definitions: IndexDefinition[] = [];
    for (const index of indexRows) {
      const binds = { owner: index.OWNER, indexName: index.INDEX_NAME };
      const expressions = await queryRows<{ COLUMN_POSITION: number; COLUMN_EXPRESSION: string }>(this.connection, `
        SELECT column_position,column_expression FROM dba_ind_expressions
         WHERE index_owner=:owner AND index_name=:indexName ORDER BY column_position`, binds);
      const expressionByPosition = new Map(expressions.map(row => [row.COLUMN_POSITION, row.COLUMN_EXPRESSION]));
      const keys = await queryRows<{ COLUMN_NAME: string; COLUMN_POSITION: number; DESCEND: 'ASC' | 'DESC' }>(this.connection, `
        SELECT column_name,column_position,descend FROM dba_ind_columns
         WHERE index_owner=:owner AND index_name=:indexName ORDER BY column_position`, binds);
      definitions.push({ reference: { owner: index.OWNER, name: index.INDEX_NAME }, type: index.INDEX_TYPE,
        unique: index.UNIQUENESS === 'UNIQUE', visible: index.VISIBILITY === 'VISIBLE', status: index.STATUS,
        partitioned: index.PARTITIONED === 'YES', compression: index.COMPRESSION,
        keys: keys.map(key => ({ column: expressionByPosition.has(key.COLUMN_POSITION) ? null : key.COLUMN_NAME,
          expression: expressionByPosition.get(key.COLUMN_POSITION) ?? null, direction: key.DESCEND })),
      });
    }
    return definitions;
  }

  async prerequisites(table: ObjectReference): Promise<Prerequisite[]> {
    const rows = await queryRows<{ REFERENCED_OWNER: string | null; REFERENCED_NAME: string;
      REFERENCED_TYPE: string; REFERENCED_LINK_NAME: string | null }>(this.connection, `
      SELECT DISTINCT d.referenced_owner,d.referenced_name,d.referenced_type,d.referenced_link_name
        FROM dba_dependencies d
       WHERE ((d.owner=:owner AND d.name=:tableName AND d.type='TABLE') OR
         (d.type='INDEX' AND EXISTS (SELECT 1 FROM dba_indexes i WHERE i.owner=d.owner AND i.index_name=d.name
           AND i.table_owner=:owner AND i.table_name=:tableName)))
         AND (d.referenced_link_name IS NOT NULL OR
           (d.referenced_type<>'TABLE' AND NOT EXISTS (SELECT 1 FROM dba_users u
             WHERE u.username=d.referenced_owner AND u.oracle_maintained='Y')))
         AND NOT EXISTS (SELECT 1 FROM dba_tab_identity_cols identity_column
           WHERE identity_column.owner=d.referenced_owner AND identity_column.sequence_name=d.referenced_name
             AND d.referenced_type='SEQUENCE')
       ORDER BY d.referenced_owner,d.referenced_name`, { owner: table.owner, tableName: table.name });
    return rows.map(row => ({ requiredBy: table,
      reference: { owner: row.REFERENCED_OWNER ?? 'PUBLIC', name: row.REFERENCED_NAME },
      type: row.REFERENCED_TYPE, databaseLink: row.REFERENCED_LINK_NAME }));
  }
}
