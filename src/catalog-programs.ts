import { z } from 'zod';
import {
  objectKey,
  qualifiedName,
  uniqueReferences,
  type NormalizedSelection,
  type ProgramUnit,
} from './model.js';
import {
  catalogFailure,
  orderedRows,
  singleRow,
  uniqueRows,
} from './catalog-decoding.js';
import { programDeclaration } from './programs.js';
import type { CatalogReader, CatalogQuery } from './catalog-reader.js';

const yn = z.enum(['Y', 'N']);
const yesNo = z.enum(['YES', 'NO']);
const objectRow = z.object({
  OBJECT_TYPE: z.enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY']),
  OBJECT_ID: z.number().int().positive(),
  LAST_DDL_TIME: z.string(),
  STATUS: z.enum(['VALID', 'INVALID']),
  EDITIONABLE: yn,
  EDITION_NAME: z.string().nullable(),
  SHARING: z.string(),
  ORACLE_MAINTAINED: yn,
});
const sourceRow = z.object({
  LINE: z.number().int().positive(),
  TEXT: z.string().nullable(),
});
const memberRow = z.object({
  PROCEDURE_NAME: z.string().nullable(),
  SUBPROGRAM_ID: z.number().int().nonnegative(),
  OVERLOAD: z.string().nullable(),
  AUTHID: z.enum(['DEFINER', 'CURRENT_USER']).nullable(),
  DETERMINISTIC: yesNo,
  RESULT_CACHE: yesNo,
  PIPELINED: yesNo,
  PARALLEL: yesNo,
  AGGREGATE: yesNo,
  SQL_MACRO: z.enum(['NULL', 'SCALAR', 'TABLE']).nullable(),
  INTERFACE: yesNo,
  POLYMORPHIC: z.enum(['NULL', 'ROW', 'TABLE', 'LEAF']).nullable(),
  IMPLTYPEOWNER: z.string().nullable(),
});
const argumentRow = z.object({
  SUBPROGRAM_ID: z.number().int().positive(),
  POSITION: z.number().int().nonnegative(),
  DATA_LEVEL: z.number().int().nonnegative(),
  SEQUENCE: z.number().int().positive(),
});
const settingsRow = z.object({
  PLSQL_OPTIMIZE_LEVEL: z.number().int().min(0).max(3),
  PLSQL_CODE_TYPE: z.enum(['INTERPRETED', 'NATIVE']),
  PLSQL_DEBUG: z.enum(['TRUE', 'FALSE']),
  PLSQL_WARNINGS: z.string(),
  NLS_LENGTH_SEMANTICS: z.enum(['BYTE', 'CHAR']),
  PLSQL_CCFLAGS: z.string().nullable(),
  PLSCOPE_SETTINGS: z.string(),
  PLSQL_IMPLICIT_CONVERSION_BOOL: z.enum(['TRUE', 'FALSE']).nullable(),
});
const dependencyRow = z.object({
  REFERENCED_OWNER: z.string().min(1),
  REFERENCED_NAME: z.string().min(1),
  REFERENCED_TYPE: z.string().min(1),
  REFERENCED_LINK_NAME: z.string().nullable(),
  ORACLE_MAINTAINED: yn,
});

export async function readPrograms(
  reader: CatalogReader,
  selection: NormalizedSelection,
): Promise<ProgramUnit[]> {
  const capabilities = await reader.rows(
    'catalog-capabilities',
    z.object({ TABLE_NAME: z.string(), COLUMN_NAME: z.string() }),
    `SELECT table_name,column_name FROM all_tab_columns WHERE owner='SYS' AND
      ((table_name='ALL_PLSQL_OBJECT_SETTINGS' AND column_name='PLSQL_IMPLICIT_CONVERSION_BOOL') OR
       (table_name='ALL_PROCEDURES' AND column_name IN ('SQL_MACRO','POLYMORPHIC')))`,
  );
  const has = (table: string, column: string) =>
    capabilities.some(
      (row) => row.TABLE_NAME === table && row.COLUMN_NAME === column,
    );
  if (
    !has('ALL_PROCEDURES', 'SQL_MACRO') ||
    !has('ALL_PROCEDURES', 'POLYMORPHIC') ||
    !has('ALL_PLSQL_OBJECT_SETTINGS', 'PLSQL_IMPLICIT_CONVERSION_BOOL')
  )
    catalogFailure(
      'CATALOG_INCOMPLETE_METADATA',
      'database',
      'program capabilities',
      'Program metadata capabilities require a verified source release.',
    );
  const session = singleRow(
    await reader.rows(
      'catalog-capabilities',
      z.object({ SESSION_USER: z.string() }),
      `SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS session_user FROM dual`,
    ),
    'database',
    'session user',
  );
  const packageRefs = uniqueReferences([
    ...selection.packages,
    ...[...selection.procedures, ...selection.functions].flatMap((root) =>
      'package' in root && typeof root.package === 'string'
        ? [{ owner: root.owner, name: root.package }]
        : [],
    ),
  ]);
  const roots = uniqueReferences([
    ...packageRefs,
    ...selection.procedures.filter((root) => !('package' in root)),
    ...selection.functions.filter((root) => !('package' in root)),
  ]);
  const objectQuery = {
    category: 'program-objects',
    schema: objectRow,
    bindNames: ['owner', 'name'],
    sql: `SELECT o.object_type,o.object_id,TO_CHAR(o.last_ddl_time,'YYYYMMDDHH24MISS') AS last_ddl_time,
      o.status,o.editionable,o.edition_name,o.sharing,u.oracle_maintained
      FROM ${reader.catalogView('objects')} o JOIN ${reader.catalogView('users')} u ON u.username=o.owner
      /* selection */ WHERE o.owner=:owner AND o.object_name=:name AND o.object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY') ORDER BY o.object_type`,
  } satisfies CatalogQuery<typeof objectRow>;
  const result: ProgramUnit[] = [];
  for (const batch of reader.batches(roots)) {
    const requests = batch.map((ref) => ({ owner: ref.owner, name: ref.name }));
    const before = await reader.groupedRows(objectQuery, requests);
    for (const reference of batch) {
      const objects = before.get(objectKey(reference))!;
      uniqueRows(objects, ['OBJECT_TYPE'], qualifiedName(reference));
      const isPackage = packageRefs.some(
        (ref) => objectKey(ref) === objectKey(reference),
      );
      const spec = objects.find((row) => row.OBJECT_TYPE === 'PACKAGE');
      const body = objects.find((row) => row.OBJECT_TYPE === 'PACKAGE BODY');
      const selectionFailure = (code: string): never => {
        throw Object.assign(
          new Error(
            `${code}: ${qualifiedName(reference)}: selected routine identity or kind is missing/inaccessible.`,
          ),
          { code },
        );
      };
      if (!objects.length || (isPackage && !spec))
        selectionFailure(
          isPackage
            ? 'PACKAGE_SELECTION_NOT_FOUND'
            : selection.functions.some(
                  (root) =>
                    !('package' in root) &&
                    objectKey(root) === objectKey(reference),
                )
              ? 'FUNCTION_SELECTION_NOT_FOUND'
              : 'PROCEDURE_SELECTION_NOT_FOUND',
        );
      for (const [roots, kind] of [
        [selection.procedures, 'PROCEDURE'],
        [selection.functions, 'FUNCTION'],
      ] as const) {
        if (
          roots.some(
            (root) =>
              !('package' in root) && objectKey(root) === objectKey(reference),
          ) &&
          !objects.some((object) => object.OBJECT_TYPE === kind)
        )
          selectionFailure(`${kind}_SELECTION_NOT_FOUND`);
      }
      if (
        isPackage &&
        !body &&
        !reader.isDba &&
        session.SESSION_USER !== reference.owner
      ) {
        const error = new Error(
          `PACKAGE_BODY_VISIBILITY: ${qualifiedName(reference)}: use owning-schema access or explicitly selected DBA catalog scope to establish body absence.`,
        );
        Object.assign(error, { code: 'PACKAGE_BODY_VISIBILITY' });
        throw error;
      }
      for (const object of objects) {
        const type = object.OBJECT_TYPE;
        const binds = { owner: reference.owner, name: reference.name, type };
        const readSettings = () =>
          reader.rows(
            'program-settings',
            settingsRow,
            `SELECT plsql_optimize_level,plsql_code_type,plsql_debug,plsql_warnings,nls_length_semantics,plsql_ccflags,plscope_settings,plsql_implicit_conversion_bool FROM ${reader.catalogView('settings')} WHERE owner=:owner AND name=:name AND type=:type`,
            binds,
          );
        const settings = singleRow(
          await readSettings(),
          qualifiedName(reference),
          'compiler settings',
        );
        const lines = await reader.rows(
          'program-source',
          sourceRow,
          `SELECT line,text FROM ${reader.catalogView('source')} WHERE owner=:owner AND name=:name AND type=:type ORDER BY line`,
          binds,
        );
        orderedRows(lines, 'LINE', qualifiedName(reference));
        const members =
          type === 'PACKAGE BODY'
            ? []
            : await reader.rows(
                'program-members',
                memberRow,
                `SELECT procedure_name,subprogram_id,overload,authid,deterministic,result_cache,pipelined,parallel,aggregate,sql_macro,interface,polymorphic,impltypeowner
           FROM ${reader.catalogView('procedures')} WHERE owner=:owner AND object_name=:name AND object_type=:type ORDER BY subprogram_id`,
                binds,
              );
        uniqueRows(members, ['SUBPROGRAM_ID'], qualifiedName(reference));
        const argumentsRows =
          type === 'PACKAGE BODY'
            ? []
            : await reader.rows(
                'program-arguments',
                argumentRow,
                `SELECT subprogram_id,position,data_level,sequence FROM ${reader.catalogView('arguments')} WHERE owner=:owner AND
           ((:type='PACKAGE' AND package_name=:name) OR (:type<>'PACKAGE' AND package_name IS NULL AND object_name=:name)) ORDER BY subprogram_id,sequence`,
                binds,
              );
        uniqueRows(
          argumentsRows,
          ['SUBPROGRAM_ID', 'SEQUENCE'],
          qualifiedName(reference),
        );
        const dependencies = await reader.rows(
          'program-dependencies',
          dependencyRow,
          `SELECT DISTINCT d.referenced_owner,d.referenced_name,d.referenced_type,d.referenced_link_name,u.oracle_maintained
           FROM ${reader.catalogView('dependencies')} d LEFT JOIN ${reader.catalogView('users')} u ON u.username=d.referenced_owner
           WHERE d.owner=:owner AND d.name=:name AND d.type=:type ORDER BY d.referenced_owner,d.referenced_name,d.referenced_type`,
          binds,
        );
        uniqueRows(
          dependencies,
          [
            'REFERENCED_OWNER',
            'REFERENCED_NAME',
            'REFERENCED_TYPE',
            'REFERENCED_LINK_NAME',
          ],
          qualifiedName(reference),
        );
        for (const argument of argumentsRows)
          if (
            !members.some(
              (member) => member.SUBPROGRAM_ID === argument.SUBPROGRAM_ID,
            )
          )
            catalogFailure(
              'CATALOG_INCOMPLETE_METADATA',
              qualifiedName(reference),
              'argument subprogram',
            );
        for (const id of new Set(
          argumentsRows.map((argument) => argument.SUBPROGRAM_ID),
        ))
          orderedRows(
            argumentsRows.filter((argument) => argument.SUBPROGRAM_ID === id),
            'SEQUENCE',
            qualifiedName(reference),
          );
        const properties = (row: z.infer<typeof memberRow>) => ({
          deterministic: row.DETERMINISTIC === 'YES',
          resultCache: row.RESULT_CACHE === 'YES',
          pipelined: row.PIPELINED === 'YES',
          parallelEnabled: row.PARALLEL === 'YES',
          aggregate: row.AGGREGATE === 'YES',
          sqlMacro:
            row.SQL_MACRO === null || row.SQL_MACRO === 'NULL'
              ? ('NONE' as const)
              : row.SQL_MACRO,
        });
        const top =
          type === 'PACKAGE BODY'
            ? null
            : singleRow(
                members.filter((row) => row.PROCEDURE_NAME === null),
                qualifiedName(reference),
                'top-level procedure metadata',
              );
        const unit: ProgramUnit = {
          reference,
          type,
          sourceLines: lines.map((line) => ({
            line: line.LINE,
            text: line.TEXT ?? '',
          })),
          status: object.STATUS,
          editionable: object.EDITIONABLE === 'Y',
          editionName: object.EDITION_NAME,
          authid: top?.AUTHID ?? (type === 'PACKAGE BODY' ? null : 'DEFINER'),
          packageBodyPresent: type === 'PACKAGE' ? Boolean(body) : null,
          routineProperties:
            type === 'PROCEDURE' || type === 'FUNCTION'
              ? properties(top!)
              : null,
          members:
            type === 'PACKAGE'
              ? members
                  .filter((row) => row.PROCEDURE_NAME !== null)
                  .map((row) => ({
                    name: row.PROCEDURE_NAME!,
                    subprogramId: row.SUBPROGRAM_ID,
                    overload: row.OVERLOAD,
                    kind: argumentsRows.some(
                      (arg) =>
                        arg.SUBPROGRAM_ID === row.SUBPROGRAM_ID &&
                        arg.POSITION === 0 &&
                        arg.DATA_LEVEL === 0,
                    )
                      ? 'function'
                      : 'procedure',
                    routineProperties: properties(row),
                  }))
              : [],
          dependencies: dependencies.map((row) => ({
            reference: {
              owner: row.REFERENCED_OWNER,
              name: row.REFERENCED_NAME,
            },
            type: row.REFERENCED_TYPE,
            databaseLink: row.REFERENCED_LINK_NAME,
            oracleMaintained: row.ORACLE_MAINTAINED === 'Y',
          })),
          compilerSettings: {
            plsqlOptimizeLevel: settings.PLSQL_OPTIMIZE_LEVEL,
            plsqlCodeType: settings.PLSQL_CODE_TYPE,
            plsqlDebug: settings.PLSQL_DEBUG === 'TRUE',
            plsqlWarnings: settings.PLSQL_WARNINGS,
            nlsLengthSemantics: settings.NLS_LENGTH_SEMANTICS,
            plsqlCcflags: settings.PLSQL_CCFLAGS,
            plscopeSettings: settings.PLSCOPE_SETTINGS,
            plsqlImplicitConversionBool:
              settings.PLSQL_IMPLICIT_CONVERSION_BOOL === null
                ? null
                : settings.PLSQL_IMPLICIT_CONVERSION_BOOL === 'TRUE',
          },
          unsupportedFeatures:
            object.SHARING !== 'NONE' ||
            object.ORACLE_MAINTAINED === 'Y' ||
            members.some(
              (row) =>
                row.INTERFACE === 'YES' ||
                (row.POLYMORPHIC !== null && row.POLYMORPHIC !== 'NULL') ||
                row.IMPLTYPEOWNER !== null,
            )
              ? [
                  'Unsupported shared, maintained, or specialized program metadata',
                ]
              : [],
        };
        if (type === 'PACKAGE')
          for (const [roots, kind] of [
            [selection.procedures, 'procedure'],
            [selection.functions, 'function'],
          ] as const) {
            for (const root of roots)
              if (
                'package' in root &&
                root.owner === reference.owner &&
                root.package === reference.name &&
                (!body ||
                  !unit.members.some(
                    (member) =>
                      member.name === root.name && member.kind === kind,
                  ))
              )
                selectionFailure(`${kind.toUpperCase()}_SELECTION_NOT_FOUND`);
          }
        // Catalog null AUTHID on constants-only specs needs declaration confirmation.
        if (top && top.AUTHID === null) {
          const words = programDeclaration(unit)
            .tokens.filter((token) => !token.quoted)
            .map((token) => token.value);
          unit.authid =
            words.includes('AUTHID') &&
            words[words.indexOf('AUTHID') + 1] === 'CURRENT_USER'
              ? 'CURRENT_USER'
              : 'DEFINER';
        }
        if (
          JSON.stringify(settings) !==
          JSON.stringify(
            singleRow(
              await readSettings(),
              qualifiedName(reference),
              'compiler settings',
            ),
          )
        )
          catalogFailure(
            'CATALOG_INCOMPLETE_METADATA',
            qualifiedName(reference),
            'concurrent compiler metadata',
          );
        result.push(unit);
      }
    }
    const after = await reader.groupedRows(objectQuery, requests);
    for (const reference of batch)
      if (
        JSON.stringify(before.get(objectKey(reference))) !==
        JSON.stringify(after.get(objectKey(reference)))
      )
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          qualifiedName(reference),
          'concurrent program DDL',
        );
  }
  return result;
}
