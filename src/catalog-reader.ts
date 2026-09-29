/**
 * Provides shared query access for the catalog adapter's object readers. It
 * selects the ALL or DBA catalog view family, measures queries for extraction
 * progress, and batches member reads using exact bound owner/name pairs.
 * catalogRows handles row decoding, complete result-set reads, and result-set
 * closure. Callers await queries sequentially on the supplied connection and
 * retain responsibility for opening and closing that connection.
 */
import type { BindParameters, Connection } from 'oracledb';
import type { z } from 'zod';
import { ExtractionProgress, type QueryCategory } from './progress.js';
import { objectKey, uniqueReferences, type ObjectReference } from './model.js';
import { catalogRows, catalogFailure } from './catalog-decoding.js';
import { memberRowSchema } from './catalog-schemas.js';

export type CatalogScope = 'all' | 'dba';
const catalogViews = {
  sequences: { all: 'all_sequences', dba: 'dba_sequences' },
  synonyms: { all: 'all_synonyms', dba: 'dba_synonyms' },
  source: { all: 'all_source', dba: 'dba_source' },
  procedures: { all: 'all_procedures', dba: 'dba_procedures' },
  arguments: { all: 'all_arguments', dba: 'dba_arguments' },
  settings: {
    all: 'all_plsql_object_settings',
    dba: 'dba_plsql_object_settings',
  },
  constraints: { all: 'all_constraints', dba: 'dba_constraints' },
  consColumns: { all: 'all_cons_columns', dba: 'dba_cons_columns' },
  tables: { all: 'all_tables', dba: 'dba_tables' },
  users: { all: 'all_users', dba: 'dba_users' },
  externalTables: { all: 'all_external_tables', dba: 'dba_external_tables' },
  objectTables: { all: 'all_object_tables', dba: 'dba_object_tables' },
  mviews: { all: 'all_mviews', dba: 'dba_mviews' },
  encryptedColumns: {
    all: 'all_encrypted_columns',
    dba: 'dba_encrypted_columns',
  },
  tabComments: { all: 'all_tab_comments', dba: 'dba_tab_comments' },
  tabIdentityCols: {
    all: 'all_tab_identity_cols',
    dba: 'dba_tab_identity_cols',
  },
  tabCols: { all: 'all_tab_cols', dba: 'dba_tab_cols' },
  colComments: { all: 'all_col_comments', dba: 'dba_col_comments' },
  indexes: { all: 'all_indexes', dba: 'dba_indexes' },
  indExpressions: { all: 'all_ind_expressions', dba: 'dba_ind_expressions' },
  indColumns: { all: 'all_ind_columns', dba: 'dba_ind_columns' },
  views: { all: 'all_views', dba: 'dba_views' },
  objects: { all: 'all_objects', dba: 'dba_objects' },
  tabColumns: { all: 'all_tab_columns', dba: 'dba_tab_columns' },
  dependencies: { all: 'all_dependencies', dba: 'dba_dependencies' },
} as const;
type CatalogView = keyof typeof catalogViews;

export interface MemberQuery<S extends z.ZodTypeAny = z.ZodTypeAny> {
  category: QueryCategory;
  schema: S;
  view: CatalogView;
  ownerColumn: string;
  nameColumn: string;
  fields: string;
  position: string;
  singleBind: string;
}

export interface CatalogQuery<S extends z.ZodTypeAny = z.ZodTypeAny> {
  category: QueryCategory;
  schema: S;
  /** First two binds identify the selected owner/name; remaining binds are context. */
  bindNames: string[];
  sql: string;
}

/** Shared query access for one adapter; connection lifetime belongs to the caller. */
export class CatalogReader {
  private readonly preparedRows = new Map<string, unknown[]>();
  private readonly preparedMembers = new Map<
    QueryCategory,
    Map<string, unknown[]>
  >();
  constructor(
    private readonly connection: Connection,
    private readonly scope: CatalogScope = 'all',
    private readonly progress = new ExtractionProgress(),
    private readonly batchSize = 32,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) {
      throw new Error('Catalog batch size must be an integer from 1 to 128.');
    }
  }

  get isDba(): boolean {
    return this.scope === 'dba';
  }

  catalogView(name: CatalogView): string {
    return catalogViews[name][this.scope];
  }

  *batches(references: ObjectReference[]): Generator<ObjectReference[]> {
    const unique = uniqueReferences(references);
    for (let offset = 0; offset < unique.length; offset += this.batchSize) {
      yield unique.slice(offset, offset + this.batchSize);
    }
  }

  private rowKey(query: CatalogQuery, binds: Record<string, string>): string {
    return JSON.stringify([
      query.category,
      ...query.bindNames.map((name) => binds[name]),
    ]);
  }

  read<S extends z.ZodTypeAny>(
    query: CatalogQuery<S>,
    binds: Record<string, string>,
  ): Promise<z.infer<S>[]> {
    const cached = this.preparedRows.get(this.rowKey(query, binds));
    if (cached !== undefined) return Promise.resolve(cached as z.infer<S>[]);
    return this.rows(
      query.category,
      query.schema,
      query.sql.replace('/* selection */', ''),
      binds,
    );
  }

  /** Join exact bound selection rows, retaining the original joins and predicates.
   * Only the bind-only selection uses UNION ALL; catalog LONGs remain direct reads.
   * All callers supply static SQL definitions, never user SQL or identifiers.
   */
  async groupedRows<S extends z.ZodTypeAny>(
    query: CatalogQuery<S>,
    requests: Record<string, string>[],
  ): Promise<Map<string, z.infer<S>[]>> {
    const groups = new Map<string, z.infer<S>[]>();
    for (let offset = 0; offset < requests.length; offset += this.batchSize) {
      const batch = requests.slice(offset, offset + this.batchSize);
      if (batch.length === 1) {
        const binds = batch[0];
        groups.set(
          objectKey({
            owner: binds[query.bindNames[0]],
            name: binds[query.bindNames[1]],
          }),
          await this.read(query, binds),
        );
        continue;
      }
      const binds: Record<string, string> = {};
      const selection = batch
        .map((request, index) => {
          const key = objectKey({
            owner: request[query.bindNames[0]],
            name: request[query.bindNames[1]],
          });
          if (groups.has(key))
            throw new Error('Duplicate catalog batch request');
          groups.set(key, []);
          return (
            'SELECT ' +
            query.bindNames
              .map((name) => {
                binds[`${name}${index}`] = request[name];
                return `:${name}${index} AS q_${name}`;
              })
              .join(', ') +
            ' FROM dual'
          );
        })
        .join(' UNION ALL ');
      const projection = `selected.q_${query.bindNames[0]} AS member_owner, selected.q_${query.bindNames[1]} AS member_name, `;
      const sql = query.sql
        .replace(/:([A-Za-z]+)/g, (_, name: string) => {
          if (!query.bindNames.includes(name))
            throw new Error('Unknown catalog query bind');
          return `selected.q_${name}`;
        })
        .replace(/^SELECT (DISTINCT )?/, (prefix) => prefix + projection)
        .replace('/* selection */', 'CROSS JOIN selected_objects selected');
      const rows = await this.rows(
        query.category,
        query.schema.and(memberRowSchema),
        `WITH selected_objects AS (${selection}) ${sql}`,
        binds,
      );
      const allowed = new Set(
        batch.map((request) =>
          objectKey({
            owner: request[query.bindNames[0]],
            name: request[query.bindNames[1]],
          }),
        ),
      );
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
        // Grouping fields must not leak into model assembly or cached source facts.
        const { MEMBER_OWNER: _, MEMBER_NAME: __, ...value } = row;
        groups.get(key)!.push(value as z.infer<S>);
      }
    }
    return groups;
  }

  /** Temporary row staging is private to one sequential assembly batch. */
  async withPrefetch<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.preparedRows.clear();
      this.preparedMembers.clear();
    }
  }

  async prefetch<S extends z.ZodTypeAny>(
    query: CatalogQuery<S>,
    requests: Record<string, string>[],
  ): Promise<Map<string, z.infer<S>[]>> {
    const groups = await this.groupedRows(query, requests);
    for (const request of requests) {
      const key = objectKey({
        owner: request[query.bindNames[0]],
        name: request[query.bindNames[1]],
      });
      this.preparedRows.set(this.rowKey(query, request), groups.get(key)!);
    }
    return groups;
  }

  async prefetchMembers<S extends z.ZodTypeAny>(
    references: ObjectReference[],
    options: MemberQuery<S>,
  ): Promise<void> {
    this.preparedMembers.set(
      options.category,
      await this.memberRows(references, options),
    );
  }

  rows<S extends z.ZodTypeAny>(
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
  async memberRows<S extends z.ZodTypeAny>(
    references: ObjectReference[],
    options: MemberQuery<S>,
  ): Promise<Map<string, z.infer<S>[]>> {
    const prepared = this.preparedMembers.get(options.category);
    if (
      prepared &&
      references.every((reference) => prepared.has(objectKey(reference)))
    ) {
      return new Map(
        references.map((reference) => [
          objectKey(reference),
          prepared.get(objectKey(reference))! as z.infer<S>[],
        ]),
      );
    }
    const {
      category,
      schema,
      view,
      ownerColumn,
      nameColumn,
      fields,
      position,
      singleBind,
    } = options;
    const groups = new Map<string, z.infer<S>[]>();
    for (let offset = 0; offset < references.length; offset += this.batchSize) {
      const batch = references.slice(offset, offset + this.batchSize);
      for (const reference of batch) {
        groups.set(objectKey(reference), []);
      }
      if (batch.length === 1) {
        const reference = batch[0];
        groups.set(
          objectKey(reference),
          await this.rows(
            category,
            schema,
            `SELECT ${fields}
              FROM ${this.catalogView(view)}
             WHERE ${ownerColumn}=:owner AND ${nameColumn}=:${singleBind}
             ORDER BY ${position}`,
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
        schema.and(memberRowSchema),
        `SELECT ${ownerColumn} AS member_owner, ${nameColumn} AS member_name, ${fields}
          FROM ${this.catalogView(view)}
         WHERE ${predicates.join(' OR ')}
         ORDER BY ${ownerColumn}, ${nameColumn}, ${position}`,
        binds,
      );
      const allowed = new Set(batch.map(objectKey));
      for (const row of rows) {
        const key = objectKey({
          owner: row.MEMBER_OWNER,
          name: row.MEMBER_NAME,
        });
        if (!allowed.has(key)) {
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            'batch',
            'member',
            'Unexpected member outside selected batch',
          );
        }
        groups.get(key)!.push(row);
      }
    }
    return groups;
  }
}
