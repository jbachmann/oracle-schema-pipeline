/**
 * Adapts Oracle's read-only catalog metadata to the SourceCatalog interface used
 * by extraction. Each adapter shares one query reader and one constraint cache
 * owner across table, foreign-key, and view reads. Database-version and external
 * prerequisite queries live here; object assembly belongs to the focused readers.
 * The caller supplies and manages the connection. Later pipeline stages work
 * from the extracted document without querying Oracle.
 */
import type { Connection } from 'oracledb';
import type { SourceCatalog } from './extract.js';
import { ExtractionProgress } from './progress.js';
import { CatalogReader, type CatalogScope } from './catalog-reader.js';
import { ConstraintReader } from './catalog-constraints.js';
import { readTable } from './catalog-tables.js';
import { readView, readViewDependencies } from './catalog-views.js';
import {
  qualifiedName,
  type ForeignKeyDefinition,
  type ObjectReference,
  type Prerequisite,
  type TableDefinition,
  type ViewDefinition,
} from './model.js';
import { uniqueRows, singleRow } from './catalog-decoding.js';
import {
  dependencyRowSchema,
  databaseVersionRowSchema,
} from './catalog-schemas.js';

export type { CatalogScope } from './catalog-reader.js';

export class OracleCatalog implements SourceCatalog {
  private readonly reader: CatalogReader;
  private readonly constraints: ConstraintReader;

  constructor(
    connection: Connection,
    scope: CatalogScope = 'all',
    progress = new ExtractionProgress(),
    batchSize = 32,
  ) {
    this.reader = new CatalogReader(connection, scope, progress, batchSize);
    this.constraints = new ConstraintReader(this.reader);
  }

  async foreignKeys(table: ObjectReference): Promise<ForeignKeyDefinition[]> {
    return this.constraints.foreignKeys(table);
  }

  async table(reference: ObjectReference): Promise<TableDefinition> {
    return readTable(this.reader, this.constraints, reference);
  }

  async view(reference: ObjectReference): Promise<ViewDefinition> {
    return readView(this.reader, reference);
  }

  async viewDependencies(
    reference: ObjectReference,
  ): Promise<ViewDefinition['dependencies']> {
    return readViewDependencies(this.reader, reference);
  }

  async databaseVersion(): Promise<string> {
    const rows = await this.reader.rows(
      'database-version',
      databaseVersionRowSchema,
      `SELECT version
        FROM product_component_version
       WHERE product LIKE 'Oracle%Database%'
       ORDER BY product`,
    );
    return singleRow(rows, 'database', 'VERSION').VERSION;
  }

  async prerequisites(table: ObjectReference): Promise<Prerequisite[]> {
    const rows = await this.reader.rows(
      'prerequisites',
      dependencyRowSchema,
      `SELECT DISTINCT d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name
        FROM ${this.reader.catalogView('dependencies')} d
       WHERE ((d.owner=:owner AND d.name=:tableName AND d.type='TABLE') OR
         (d.type='INDEX' AND EXISTS (
           SELECT 1
             FROM ${this.reader.catalogView('indexes')} i
            WHERE i.owner=d.owner AND i.index_name=d.name
              AND i.table_owner=:owner AND i.table_name=:tableName)))
         AND (d.referenced_link_name IS NOT NULL OR
           (d.referenced_type<>'TABLE' AND NOT EXISTS (
             SELECT 1
               FROM ${this.reader.catalogView('users')} u
              WHERE u.username=d.referenced_owner AND u.oracle_maintained='Y')))
         AND NOT EXISTS (
           SELECT 1
             FROM ${this.reader.catalogView('tabIdentityCols')} identity_column
            WHERE identity_column.owner=d.referenced_owner
              AND identity_column.sequence_name=d.referenced_name
              AND d.referenced_type='SEQUENCE')
       ORDER BY d.referenced_owner, d.referenced_name`,
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
