import { objectAssertions } from './object-assertions.js';
import { renderProgram } from './program-ddl.js';
import { renderSequence } from './sequences.js';
import { renderSynonym } from './synonyms.js';
import { renderObjectGrant } from './object-grants.js';
/**
 * Coordinates SQL preparation from parsed target metadata and semantic analysis.
 * Consumes the independently analyzed creation graph and places deduplicated
 * grants before the relational and program operations that need them.
 * Object rendering lives in ddl.ts; sql-preparation.ts collects SQL and diagnostics.
 *
 * validate.ts runs preparation to find rendering errors alongside metadata
 * errors. Once validation succeeds, generate.ts joins the prepared operations
 * into the output script. Preparation is entirely offline and never executes
 * SQL or authorizes publication on its own.
 */
import { schemaOwners } from './schema-owners.js';
import { type analyzeTarget } from './semantic.js';
import { renderComment } from './comments.js';
import {
  renderTable,
  renderIndex,
  renderLocalConstraint,
  renderForeignKey,
  renderView,
} from './ddl.js';
import {
  quoteIdentifier,
  qualifiedName,
  objectKey,
  type TableDefinition,
  type TargetDocument,
} from './model.js';
import {
  createSqlPreparation,
  type SqlCollector,
  type SqlPreparation,
} from './sql-preparation.js';

function orderedColumns(table: TableDefinition) {
  return [...table.columns].sort(
    (left, right) => left.position - right.position,
  );
}

function emitPreamble(document: TargetDocument, { emit }: SqlCollector): void {
  emit(
    'document',
    `-- Generated from oracle-schema-pipeline format ${document.formatVersion}. Catalog definitions and selected PL/SQL source.`,
    'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
    'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
    'SET DEFINE OFF',
    'SET SQLBLANKLINES ON',
    'SET ECHO OFF',
    'ALTER SESSION SET DEFERRED_SEGMENT_CREATION=TRUE;',
  );
}

function emitSchemas(document: TargetDocument, { emit }: SqlCollector): void {
  if (!document.policy.createSchemas) {
    return;
  }
  const tablespace = quoteIdentifier(document.policy.defaultTablespace);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  for (const owner of schemaOwners(document)) {
    const create = `CREATE USER ${quoteIdentifier(owner)} NO AUTHENTICATION DEFAULT TABLESPACE ${tablespace} QUOTA UNLIMITED ON ${tablespace}`;
    // Native IF NOT EXISTS also skips conflicting roles on the pinned Oracle
    // image. Check users explicitly and let every creation error remain fatal.
    emit(
      quoteIdentifier(owner),
      `DECLARE\n  n NUMBER;\nBEGIN\n  SELECT COUNT(*) INTO n FROM ALL_USERS WHERE USERNAME = ${literal(owner)};\n  IF n = 0 THEN\n    EXECUTE IMMEDIATE ${literal(create)};\n  END IF;\nEND;\n/`,
    );
  }
}

function emitComments(
  tables: TableDefinition[],
  { emit, attemptRender }: SqlCollector,
): void {
  for (const table of tables) {
    const tableName = qualifiedName(table.reference);
    const comment = table.comment;
    if (comment !== null) {
      emit(
        tableName,
        attemptRender('UNRENDERABLE_TABLE_COMMENT', tableName, () =>
          renderComment(table.reference, null, comment),
        ),
      );
    }
    for (const column of orderedColumns(table)) {
      const columnComment = column.comment;
      if (columnComment !== null) {
        const object = `${tableName}.${column.name}`;
        emit(
          object,
          attemptRender('UNRENDERABLE_COLUMN_COMMENT', object, () =>
            renderComment(table.reference, column.name, columnComment),
          ),
        );
      }
    }
  }
}

/** Internal preparation of parsed metadata; never authorizes publication. */
export function prepareSql(
  document: TargetDocument,
  analysis: ReturnType<typeof analyzeTarget>,
): SqlPreparation {
  const collector = createSqlPreparation();
  emitPreamble(document, collector);
  emitSchemas(document, collector);
  for (const operation of analysis.orderedOperations) {
    const object = qualifiedName(operation.reference);
    const table = document.tables.find(
      (item) =>
        objectKey(item.reference) ===
        objectKey(operation.parent ?? operation.reference),
    );
    switch (operation.type) {
      case 'SCHEMA':
        break;
      case 'TABLE':
        collector.emit(
          object,
          renderTable(
            table!,
            orderedColumns(table!),
            document.policy,
            collector.attemptRender,
          ),
        );
        break;
      case 'COMMENTS':
        emitComments([table!], collector);
        break;
      case 'INDEX': {
        const index = table!.indexes.find(
          (item) =>
            objectKey(item.reference) === objectKey(operation.reference),
        )!;
        collector.emit(
          object,
          renderIndex(table!.reference, index, collector.attemptRender),
        );
        break;
      }
      case 'CONSTRAINT':
      case 'FOREIGN KEY': {
        const constraint = table!.constraints.find(
          (item) => item.name === operation.name,
        )!;
        if (constraint.kind === 'foreign-key')
          collector.emit(
            `${object}/${constraint.name}`,
            renderForeignKey(table!.reference, constraint),
          );
        else if (constraint.kind !== 'not-null')
          collector.emit(
            `${object}/${constraint.name}`,
            renderLocalConstraint(table!.reference, constraint),
          );
        break;
      }
      case 'VIEW':
        collector.emit(
          object,
          renderView(
            document.views.find(
              (item) =>
                objectKey(item.reference) === objectKey(operation.reference),
            )!,
          ),
        );
        break;
      case 'SEQUENCE':
        collector.emit(
          object,
          renderSequence(
            document.sequences.find(
              (item) =>
                objectKey(item.reference) === objectKey(operation.reference),
            )!,
            document,
          ),
        );
        break;
      case 'SYNONYM':
        collector.emit(
          object,
          renderSynonym(
            document.synonyms.find(
              (item) =>
                objectKey(item.reference) === objectKey(operation.reference),
            )!,
          ),
        );
        break;
      case 'GRANT':
        collector.emit(object, renderObjectGrant(operation.grant!));
        break;
      default: {
        const unit = document.programUnits.find(
          (item) =>
            item.type === operation.type &&
            objectKey(item.reference) === objectKey(operation.reference),
        )!;
        collector.emit(
          object,
          collector.attemptRender('PROGRAM_SOURCE_IDENTITY', object, () =>
            renderProgram(unit),
          ),
        );
      }
    }
  }
  for (const assertion of objectAssertions(document))
    collector.emit('document', assertion);
  collector.emit('document', 'PROMPT Schema reconstruction completed.');
  return collector.result;
}
