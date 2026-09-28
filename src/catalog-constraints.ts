/**
 * Loads and converts Oracle constraints for foreign-key discovery and table
 * assembly. It resolves ordered child/parent column pairs, preserves constraint
 * state, and distinguishes canonical NOT NULL checks from other check predicates.
 * One reader per adapter owns the constraint and column caches, publishing entries
 * only after the requested metadata passes validation. Unsupported constraint
 * kinds are returned with the definitions for inclusion in table diagnostics.
 */
import { catalogQueries } from './catalog-queries.js';
import type { CatalogReader } from './catalog-reader.js';
import {
  qualifiedName,
  objectKey,
  uniqueReferences,
  type ConstraintDefinition,
  type ForeignKeyDefinition,
  type ObjectReference,
} from './model.js';
import { catalogFailure, uniqueRows, orderedRows } from './catalog-decoding.js';
import {
  orderedColumnRowSchema,
  type ConstraintRow,
} from './catalog-schemas.js';

/** Both constraint entry points share these caches for the adapter's lifetime. */
export class ConstraintReader {
  private readonly constraintCache = new Map<string, ConstraintRow[]>();
  private readonly constraintColumnCache = new Map<string, string[]>();

  constructor(private readonly reader: CatalogReader) {}

  /** Roll back entries added by a failed assembly without discarding older facts. */
  async withRollback<T>(operation: () => Promise<T>): Promise<T> {
    const constraintKeys = new Set(this.constraintCache.keys());
    const columnKeys = new Set(this.constraintColumnCache.keys());
    try {
      return await operation();
    } catch (error) {
      for (const key of this.constraintCache.keys()) {
        if (!constraintKeys.has(key)) this.constraintCache.delete(key);
      }
      for (const key of this.constraintColumnCache.keys()) {
        if (!columnKeys.has(key)) this.constraintColumnCache.delete(key);
      }
      throw error;
    }
  }

  async prefetch(references: ObjectReference[]): Promise<void> {
    const missing = references.filter(
      (reference) => !this.constraintCache.has(objectKey(reference)),
    );
    for (const batch of this.reader.batches(missing)) {
      const groups = await this.reader.groupedRows(
        catalogQueries(this.reader).constraints,
        batch.map((reference) => ({
          owner: reference.owner,
          tableName: reference.name,
        })),
      );
      for (const reference of batch) {
        uniqueRows(
          groups.get(objectKey(reference))!,
          ['OWNER', 'CONSTRAINT_NAME'],
          qualifiedName(reference),
        );
      }
      await this.prefetchConstraintColumns([...groups.values()].flat());
      for (const [key, rows] of groups) this.constraintCache.set(key, rows);
    }
  }

  private async prefetchConstraintColumns(
    rows: ConstraintRow[],
  ): Promise<void> {
    const candidates: ObjectReference[] = [];
    for (const row of rows) {
      if (!['P', 'U', 'R'].includes(row.CONSTRAINT_TYPE)) {
        continue;
      }
      candidates.push({ owner: row.OWNER, name: row.CONSTRAINT_NAME });
      if (row.CONSTRAINT_TYPE === 'R' && row.R_OWNER && row.R_CONSTRAINT_NAME) {
        candidates.push({ owner: row.R_OWNER, name: row.R_CONSTRAINT_NAME });
      }
    }
    const references = uniqueReferences(candidates).filter(
      (reference) => !this.constraintColumnCache.has(objectKey(reference)),
    );
    const groups = await this.reader.memberRows(references, {
      category: 'constraint-columns',
      schema: orderedColumnRowSchema,
      view: 'consColumns',
      ownerColumn: 'owner',
      nameColumn: 'constraint_name',
      fields: 'column_name,position',
      position: 'position',
      singleBind: 'constraintName',
    });
    for (const reference of references) {
      const members = groups.get(objectKey(reference))!;
      orderedRows(members, 'POSITION', qualifiedName(reference));
      uniqueRows(members, ['COLUMN_NAME'], qualifiedName(reference));
    }
    // Publish only after every member of the requested set has passed validation.
    for (const [key, members] of groups) {
      this.constraintColumnCache.set(
        key,
        members.map((row) => row.COLUMN_NAME),
      );
    }
  }

  private async constraintRows(
    table: ObjectReference,
  ): Promise<ConstraintRow[]> {
    const cacheKey = objectKey(table);
    const cached = this.constraintCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    // Read the LONG SEARCH_CONDITION itself. SEARCH_CONDITION_VC can truncate.
    const rows = await this.reader.read(
      catalogQueries(this.reader)['constraints'],
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
    if (cached) {
      return cached;
    }
    const rows = await this.reader.read(
      catalogQueries(this.reader)['constraint-columns'],
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
    if (!childColumns.length || childColumns.length !== parentColumns.length) {
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        `${row.OWNER}.${row.CONSTRAINT_NAME}`,
        'columnPairs',
        'Incomplete composite FK metadata',
      );
    }
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
    for (const row of await this.constraintRows(table)) {
      if (row.CONSTRAINT_TYPE === 'R') {
        definitions.push(await this.foreignKey(row));
      }
    }
    return definitions;
  }

  async tableConstraints(
    reference: ObjectReference,
    columnNames: ReadonlySet<string>,
  ): Promise<{
    definitions: ConstraintDefinition[];
    unsupportedFeatures: string[];
  }> {
    const unsupportedFeatures: string[] = [];
    const constraints: ConstraintDefinition[] = [];
    for (const row of await this.constraintRows(reference)) {
      if ((row.INDEX_OWNER === null) !== (row.INDEX_NAME === null)) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          `${row.OWNER}.${row.CONSTRAINT_NAME}`,
          'INDEX_OWNER,INDEX_NAME',
        );
      }
      const properties = this.constraintProperties(row);
      if (row.CONSTRAINT_TYPE === 'R') {
        constraints.push(await this.foreignKey(row));
      } else if (row.CONSTRAINT_TYPE === 'P' || row.CONSTRAINT_TYPE === 'U') {
        const constraintColumns = await this.constraintColumns({
          owner: row.OWNER,
          name: row.CONSTRAINT_NAME,
        });
        if (!constraintColumns.length) {
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            `${row.OWNER}.${row.CONSTRAINT_NAME}`,
            'columns',
            'Missing or inaccessible constraint columns',
          );
        }
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
        if (!row.SEARCH_CONDITION) {
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            `${row.OWNER}.${row.CONSTRAINT_NAME}`,
            'SEARCH_CONDITION',
            'Missing full check expression',
          );
        }
        // Oracle represents NOT NULL in the catalog as a check predicate. Only
        // recognize the exact canonical form; never parse arbitrary predicates.
        const notNull = /^\s*"((?:[^"]|"")+)"\s+IS\s+NOT\s+NULL\s*$/i.exec(
          row.SEARCH_CONDITION,
        );
        const columnName = notNull?.[1].replaceAll('""', '"');
        if (columnName && columnNames.has(columnName)) {
          constraints.push({
            ...properties,
            kind: 'not-null',
            column: columnName,
          });
        } else {
          constraints.push({
            ...properties,
            kind: 'check',
            expression: row.SEARCH_CONDITION,
          });
        }
      } else {
        unsupportedFeatures.push(
          `Constraint ${row.CONSTRAINT_NAME} has unsupported type ${row.CONSTRAINT_TYPE}`,
        );
      }
    }
    return { definitions: constraints, unsupportedFeatures };
  }
}
