/** Read-only, scope-preserving program metadata. No source compilation or calls. */
import { z } from 'zod';
import type { CatalogReader } from './catalog-reader.js';
import {
  catalogFailure,
  orderedRows,
  singleRow,
  uniqueRows,
} from './catalog-decoding.js';
import {
  qualifiedName,
  type ObjectReference,
  type ProgramDefinition,
  type ProgramUnit,
} from './model.js';
import {
  inspectPlsqlSource,
  packageDeclarationEvidence,
  declarationAuthid,
} from './plsql.js';

const flag = z.enum(['Y', 'N']);
const objectRow = z.object({
  OBJECT_TYPE: z.enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY']),
  STATUS: z.enum(['VALID', 'INVALID']),
  EDITIONABLE: flag,
  ORACLE_MAINTAINED: flag,
  EDITIONS_ENABLED: flag,
});
const sourceRow = z.object({
  LINE: z.number().int().positive(),
  TEXT: z.string().nullable(),
});
const memberRow = z.object({
  PROCEDURE_NAME: z.string().nullable(),
  OVERLOAD: z.string().nullable(),
  SUBPROGRAM_ID: z.number().int().nonnegative(),
  AUTHID: z.enum(['DEFINER', 'CURRENT_USER']).nullable(),
  RETURN_COUNT: z.number().int().nonnegative(),
});
const settingsRow = z.object({
  PLSQL_OPTIMIZE_LEVEL: z.number().int().min(0).max(3),
  PLSQL_CODE_TYPE: z.enum(['INTERPRETED', 'NATIVE']),
  PLSQL_DEBUG: z.enum(['TRUE', 'FALSE']),
  PLSQL_WARNINGS: z.string(),
  NLS_LENGTH_SEMANTICS: z.enum(['BYTE', 'CHAR']),
  PLSQL_CCFLAGS: z.string().nullable(),
  PLSCOPE_SETTINGS: z.string(),
});
const dependencyRow = z.object({
  REFERENCED_OWNER: z.string().min(1),
  REFERENCED_NAME: z.string().min(1),
  REFERENCED_TYPE: z.string().min(1),
  REFERENCED_LINK_NAME: z.string().nullable(),
  ORACLE_MAINTAINED: flag,
});

export async function classifyProgramDependency(
  reader: CatalogReader,
  reference: ObjectReference,
  type: string,
): Promise<boolean> {
  const rows = await reader.rows(
    'program-dependencies',
    z.object({ ORACLE_MAINTAINED: flag }),
    `SELECT oracle_maintained FROM ${reader.catalogView('objects')} WHERE owner=:owner AND object_name=:programName AND object_type=:objectType`,
    { owner: reference.owner, programName: reference.name, objectType: type },
  );
  return (
    singleRow(rows, qualifiedName(reference), 'oracleMaintained')
      .ORACLE_MAINTAINED === 'Y'
  );
}

export async function readProgram(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<ProgramDefinition> {
  const object = qualifiedName(reference);
  if (reader.catalogView('users') === 'all_users') {
    catalogFailure(
      'CATALOG_INCOMPLETE_METADATA',
      object,
      'sourceOwnerEditionsEnabled',
      'ALL_USERS does not expose owner edition enablement; use explicitly authorized DBA scope.',
    );
  }

  const binds = { owner: reference.owner, programName: reference.name };
  const rows = await reader.rows(
    'program',
    objectRow,
    `SELECT o.object_type, o.status, o.editionable, o.oracle_maintained, u.editions_enabled
       FROM ${reader.catalogView('objects')} o JOIN ${reader.catalogView('users')} u ON u.username=o.owner
      WHERE o.owner=:owner AND o.object_name=:programName
        AND o.object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY') ORDER BY o.object_type`,
    binds,
  );
  uniqueRows(rows, ['OBJECT_TYPE'], object);
  const header = singleRow(
    rows.filter((row) => row.OBJECT_TYPE !== 'PACKAGE BODY'),
    object,
    'program',
  );
  if (rows.length > (header.OBJECT_TYPE === 'PACKAGE' ? 2 : 1))
    catalogFailure('CATALOG_CARDINALITY', object, 'units');
  const members = await reader.rows(
    'program-members',
    memberRow,
    `SELECT p.procedure_name,p.overload,p.subprogram_id,p.authid,
       (SELECT COUNT(*) FROM ${reader.catalogView('arguments')} a
         WHERE a.owner=p.owner AND a.object_id=p.object_id AND a.subprogram_id=p.subprogram_id
           AND a.position=0 AND a.data_level=0) AS return_count
       FROM ${reader.catalogView('procedures')} p
      WHERE p.owner=:owner AND p.object_name=:programName ORDER BY p.subprogram_id`,
    binds,
  );
  uniqueRows(members, ['SUBPROGRAM_ID'], object);
  const top = singleRow(
    members.filter((row) => row.PROCEDURE_NAME === null),
    object,
    'AUTHID',
  );
  const units: ProgramUnit[] = [];
  for (const row of rows) {
    const unitBinds = { ...binds, unitType: row.OBJECT_TYPE };
    const lines = await reader.rows(
      'program-source',
      sourceRow,
      `SELECT line,text FROM ${reader.catalogView('source')}
        WHERE owner=:owner AND name=:programName AND type=:unitType ORDER BY line`,
      unitBinds,
    );
    orderedRows(lines, 'LINE', object);
    const sourceLines = lines.map((line) => ({
      line: line.LINE,
      text: line.TEXT ?? '',
    }));
    const source = sourceLines.map((line) => line.text).join('');
    if (!source.trim())
      catalogFailure('CATALOG_INCOMPLETE_METADATA', object, 'source');
    inspectPlsqlSource(source, reference, row.OBJECT_TYPE);
    const settings = singleRow(
      await reader.rows(
        'program-settings',
        settingsRow,
        `SELECT plsql_optimize_level,plsql_code_type,plsql_debug,plsql_warnings,nls_length_semantics,plsql_ccflags,plscope_settings
         FROM ${reader.catalogView('programSettings')} WHERE owner=:owner AND name=:programName AND type=:unitType`,
        unitBinds,
      ),
      object,
      'settings',
    );
    // LEFT JOIN intentionally retains missing classification for strict rejection.
    const dependencies = await reader.rows(
      'program-dependencies',
      dependencyRow,
      `SELECT d.referenced_owner,d.referenced_name,d.referenced_type,d.referenced_link_name, CASE WHEN d.referenced_link_name IS NOT NULL THEN 'N' ELSE o.oracle_maintained END AS oracle_maintained
         FROM ${reader.catalogView('dependencies')} d
         LEFT JOIN ${reader.catalogView('objects')} o ON o.owner=d.referenced_owner AND o.object_name=d.referenced_name AND o.object_type=d.referenced_type AND d.referenced_link_name IS NULL
        WHERE d.owner=:owner AND d.name=:programName AND d.type=:unitType
        ORDER BY d.referenced_owner,d.referenced_name,d.referenced_type,d.referenced_link_name`,
      unitBinds,
    );
    units.push({
      type: row.OBJECT_TYPE,
      status: row.STATUS,
      sourceLines,
      dependencies: dependencies.map((edge) => ({
        reference: { owner: edge.REFERENCED_OWNER, name: edge.REFERENCED_NAME },
        type: edge.REFERENCED_TYPE,
        databaseLink: edge.REFERENCED_LINK_NAME,
        oracleMaintained: edge.ORACLE_MAINTAINED === 'Y',
      })),
      settings: {
        plsqlOptimizeLevel: settings.PLSQL_OPTIMIZE_LEVEL,
        plsqlCodeType: settings.PLSQL_CODE_TYPE,
        plsqlDebug: settings.PLSQL_DEBUG === 'TRUE',
        plsqlWarnings: settings.PLSQL_WARNINGS,
        nlsLengthSemantics: settings.NLS_LENGTH_SEMANTICS,
        plsqlCcflags: settings.PLSQL_CCFLAGS,
        plscopeSettings: settings.PLSCOPE_SETTINGS,
      },
    });
  }
  if (top.AUTHID === null && header.OBJECT_TYPE !== 'PACKAGE')
    catalogFailure('CATALOG_INCOMPLETE_METADATA', object, 'AUTHID');
  const specification = units.find((unit) => unit.type === 'PACKAGE');
  const authid =
    top.AUTHID ??
    declarationAuthid(
      specification!.sourceLines.map((line) => line.text).join(''),
      reference,
      'PACKAGE',
    );
  const common = {
    reference,
    role: 'dependency' as const,
    authid,
    editionable: header.EDITIONABLE === 'Y',
    sourceOwnerEditionsEnabled: header.EDITIONS_ENABLED === 'Y',
    oracleMaintained: header.ORACLE_MAINTAINED === 'Y',
    unsupportedFeatures: [],
    units,
  };
  if (header.OBJECT_TYPE === 'PACKAGE') {
    const specification = units.find((unit) => unit.type === 'PACKAGE')!;
    const text = specification.sourceLines.map((line) => line.text).join('');
    const tokens = inspectPlsqlSource(text, reference, 'PACKAGE').tokens;
    const publicProcedures: { name: string; overload: string | null }[] = [];
    for (const member of members.filter(
      (member) => member.PROCEDURE_NAME !== null && member.RETURN_COUNT === 0,
    )) {
      // Cross-check catalog kind inference against declaration evidence. Do not
      // rely on IS_PROCEDURE/IS_FUNCTION columns absent on older source releases.
      if (
        !tokens.some(
          (token, index) =>
            token.value === 'PROCEDURE' &&
            text[token.start] !== '"' &&
            tokens[index + 1]?.value === member.PROCEDURE_NAME,
        )
      ) {
        catalogFailure(
          'CATALOG_INCOMPLETE_METADATA',
          object,
          'publicProcedures',
        );
      }
      publicProcedures.push({
        name: member.PROCEDURE_NAME!,
        overload: member.OVERLOAD,
      });
    }
    const { bodyRequired, procedures: declarations } =
      packageDeclarationEvidence(text, reference);
    if (
      JSON.stringify([...declarations].sort()) !==
      JSON.stringify(publicProcedures.map((member) => member.name).sort())
    )
      catalogFailure('CATALOG_INCOMPLETE_METADATA', object, 'publicProcedures');
    if (bodyRequired && !units.some((unit) => unit.type === 'PACKAGE BODY'))
      catalogFailure('CATALOG_INCOMPLETE_METADATA', object, 'packageBody');
    return { ...common, kind: 'package', bodyRequired, publicProcedures };
  }
  return {
    ...common,
    kind: header.OBJECT_TYPE === 'PROCEDURE' ? 'procedure' : 'function',
  };
}
