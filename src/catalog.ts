/**
 * Adapts Oracle's read-only catalog metadata to the SourceCatalog interface used
 * by extraction. Each adapter shares one query reader and one constraint cache
 * owner across table, foreign-key, and view reads. Database-version and external
 * prerequisite assembly lives here; shared SQL definitions serve both grouped
 * prefetch and on-demand reads. Prepared definitions are consumed on first use.
 * The caller supplies and manages the connection. Later pipeline stages work
 * from the extracted document without querying Oracle.
 */
import { catalogQueries } from './catalog-queries.js';
import type { Connection } from 'oracledb';
import type { SourceCatalog } from './extract.js';
import { ExtractionProgress } from './progress.js';
import {
  CatalogReader,
  type CatalogScope,
  type CatalogQuery,
} from './catalog-reader.js';
import { ConstraintReader } from './catalog-constraints.js';
import { readTable, indexMemberQueries } from './catalog-tables.js';
import { readView, readViewDependencies } from './catalog-views.js';
import {
  qualifiedName,
  objectKey,
  type ForeignKeyDefinition,
  type ObjectReference,
  type Prerequisite,
  type TableDefinition,
  type ViewDefinition,
} from './model.js';
import { uniqueRows, singleRow } from './catalog-decoding.js';
import { databaseVersionRowSchema } from './catalog-schemas.js';

export type { CatalogScope } from './catalog-reader.js';

export class OracleCatalog implements SourceCatalog {
  private readonly reader: CatalogReader;
  private readonly constraints: ConstraintReader;
  private readonly tables = new Map<string, TableDefinition>();
  private readonly tablePrerequisites = new Map<string, Prerequisite[]>();
  private readonly views = new Map<string, ViewDefinition>();
  private readonly dependencies = new Map<
    string,
    ViewDefinition['dependencies']
  >();

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

  async prefetchForeignKeys(references: ObjectReference[]): Promise<void> {
    for (const batch of this.reader.batches(references)) {
      await this.constraints.withRollback(async () => {
        await this.constraints.prefetch(batch);
        for (const reference of batch)
          await this.constraints.foreignKeys(reference);
      });
    }
  }

  async prefetchTables(references: ObjectReference[]): Promise<void> {
    const queries = catalogQueries(this.reader);
    for (const batch of this.reader.batches(
      references.filter((reference) => !this.tables.has(objectKey(reference))),
    )) {
      await this.constraints.withRollback(() =>
        this.reader.withPrefetch(async () => {
          const requests = batch.map((reference) => ({
            owner: reference.owner,
            tableName: reference.name,
          }));
          await this.constraints.prefetch(batch);
          for (const category of [
            'table',
            'table-comments',
            'columns',
            'column-comments',
            'identities',
            'prerequisites',
          ] as const) {
            const query: CatalogQuery = queries[category];
            await this.reader.prefetch(query, requests);
          }
          const indexes = await this.reader.prefetch(queries.indexes, requests);
          const indexRequests: {
            owner: string;
            indexName: string;
            tableOwner: string;
            tableName: string;
          }[] = [];
          for (const table of batch) {
            const rows = indexes.get(objectKey(table))!;
            uniqueRows(rows, ['OWNER', 'INDEX_NAME'], qualifiedName(table));
            for (const index of rows)
              indexRequests.push({
                owner: index.OWNER,
                indexName: index.INDEX_NAME,
                tableOwner: table.owner,
                tableName: table.name,
              });
          }
          // An index identity belongs to exactly one table, even across owners.
          uniqueRows(indexRequests, ['owner', 'indexName'], 'index batch');
          const indexReferences = indexRequests.map((request) => ({
            owner: request.owner,
            name: request.indexName,
          }));
          await this.reader.prefetchMembers(
            indexReferences,
            indexMemberQueries.expressions,
          );
          await this.reader.prefetchMembers(
            indexReferences,
            indexMemberQueries.columns,
          );
          await this.reader.prefetch(
            queries['index-dependencies'],
            indexRequests,
          );
          const prepared: {
            table: TableDefinition;
            prerequisites: Prerequisite[];
          }[] = [];
          for (const reference of batch) {
            prepared.push({
              table: await readTable(this.reader, this.constraints, reference),
              prerequisites: await this.readPrerequisites(reference),
            });
          }
          // Publish only complete, validated batches; raw staging is cleared on exit.
          for (const { table, prerequisites } of prepared) {
            this.tables.set(objectKey(table.reference), table);
            this.tablePrerequisites.set(
              objectKey(table.reference),
              prerequisites,
            );
          }
        }),
      );
    }
  }

  async prefetchViews(references: ObjectReference[]): Promise<void> {
    const queries = catalogQueries(this.reader);
    for (const batch of this.reader.batches(
      references.filter((reference) => !this.views.has(objectKey(reference))),
    )) {
      await this.reader.withPrefetch(async () => {
        const requests = batch.map((reference) => ({
          owner: reference.owner,
          viewName: reference.name,
        }));
        for (const category of [
          'view',
          'view-columns',
          'view-restrictions',
          'view-dependencies',
        ] as const) {
          const query: CatalogQuery = queries[category];
          await this.reader.prefetch(query, requests);
        }
        const prepared: ViewDefinition[] = [];
        for (const reference of batch) {
          const view = await readView(this.reader, reference);
          view.dependencies = await readViewDependencies(
            this.reader,
            reference,
          );
          prepared.push(view);
        }
        for (const view of prepared) {
          this.views.set(objectKey(view.reference), view);
          this.dependencies.set(objectKey(view.reference), view.dependencies);
        }
      });
    }
  }

  async table(reference: ObjectReference): Promise<TableDefinition> {
    const key = objectKey(reference);
    const prepared = this.tables.get(key);
    if (prepared) {
      this.tables.delete(key);
      return prepared;
    }
    return readTable(this.reader, this.constraints, reference);
  }

  async view(reference: ObjectReference): Promise<ViewDefinition> {
    const key = objectKey(reference);
    const prepared = this.views.get(key);
    if (prepared) {
      this.views.delete(key);
      return { ...prepared, dependencies: [] };
    }
    return readView(this.reader, reference);
  }

  async viewDependencies(
    reference: ObjectReference,
  ): Promise<ViewDefinition['dependencies']> {
    const key = objectKey(reference);
    const prepared = this.dependencies.get(key);
    if (prepared) {
      this.dependencies.delete(key);
      return prepared;
    }
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
    const key = objectKey(table);
    const prepared = this.tablePrerequisites.get(key);
    if (prepared) {
      this.tablePrerequisites.delete(key);
      return prepared;
    }
    return this.readPrerequisites(table);
  }

  private async readPrerequisites(
    table: ObjectReference,
  ): Promise<Prerequisite[]> {
    const rows = await this.reader.read(
      catalogQueries(this.reader)['prerequisites'],
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
