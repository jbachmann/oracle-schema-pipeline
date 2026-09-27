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
import { objectKey, type ObjectReference } from './model.js';
import { catalogRows, catalogFailure } from './catalog-decoding.js';
import { memberRowSchema } from './catalog-schemas.js';

export type CatalogScope = 'all' | 'dba';
const catalogViews = {
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

interface MemberQuery<S extends z.ZodTypeAny> {
  category: QueryCategory;
  schema: S;
  view: CatalogView;
  ownerColumn: string;
  nameColumn: string;
  fields: string;
  position: string;
  singleBind: string;
}

/** Shared query access for one adapter; connection lifetime belongs to the caller. */
export class CatalogReader {
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

  catalogView(name: CatalogView): string {
    return catalogViews[name][this.scope];
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
