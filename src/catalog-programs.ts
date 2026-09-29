import { z } from 'zod';
import type { CatalogReader } from './catalog-reader.js';
import { catalogFailure, uniqueRows } from './catalog-decoding.js';
import {
  qualifiedName,
  type ObjectReference,
  type ProgramDefinition,
  type ProgramKind,
  type ProgramUnit,
} from './model.js';

const flag = z.enum(['Y', 'N']);

/** Ownership or an enabled catalog role is required to establish body completeness. */
export async function requireMetadataVisibility(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<void> {
  const rows = await reader.rows(
    'program-metadata',
    z.object({ COMPLETE: z.literal(1) }),
    `SELECT 1 AS complete FROM dual WHERE SYS_CONTEXT('USERENV','SESSION_USER')=:owner
      OR (:scope='dba' AND (SYS_CONTEXT('USERENV','ISDBA')='TRUE'
      OR EXISTS (SELECT 1 FROM session_roles WHERE role='SELECT_CATALOG_ROLE')))`,
    {
      owner: reference.owner,
      scope: reader.catalogView('objects') === 'dba_objects' ? 'dba' : 'all',
    },
  );
  if (rows.length !== 1)
    catalogFailure(
      'PROGRAM_METADATA_UNAVAILABLE',
      qualifiedName(reference),
      'visibility',
      'Connect as the owner, or use catalog scope dba with SELECT_CATALOG_ROLE to establish complete metadata visibility.',
    );
}

export async function readProgram(
  reader: CatalogReader,
  reference: ObjectReference,
  kind: ProgramKind,
): Promise<ProgramDefinition> {
  if (!['PACKAGE', 'PROCEDURE', 'FUNCTION'].includes(kind))
    catalogFailure(
      'PROGRAM_METADATA_UNAVAILABLE',
      qualifiedName(reference),
      'kind',
      'Unsupported program kind.',
    );
  await requireMetadataVisibility(reader, reference);
  const binds = { owner: reference.owner, name: reference.name };
  const rows = await reader.rows(
    'program-metadata',
    z.object({
      OBJECT_TYPE: z.string(),
      STATUS: z.enum(['VALID', 'INVALID']),
      ORACLE_MAINTAINED: flag,
      SHARING: z.string(),
    }),
    `SELECT object_type, status, oracle_maintained, sharing FROM ${reader.catalogView('objects')}
       WHERE owner=:owner AND object_name=:name AND subobject_name IS NULL`,
    binds,
  );
  uniqueRows(rows, ['OBJECT_TYPE'], qualifiedName(reference));
  if (!rows.some((row) => row.OBJECT_TYPE === kind))
    catalogFailure(
      'PROGRAM_METADATA_UNAVAILABLE',
      qualifiedName(reference),
      kind,
      rows.length
        ? 'Selected object has a different type.'
        : 'Selected object is missing or inaccessible.',
    );
  const units: ProgramUnit[] = [];
  const unsupportedFeatures: string[] = [];
  for (const row of rows
    .filter(
      (row) =>
        row.OBJECT_TYPE === kind ||
        (kind === 'PACKAGE' && row.OBJECT_TYPE === 'PACKAGE BODY'),
    )
    .sort((a, b) => (a.OBJECT_TYPE < b.OBJECT_TYPE ? -1 : 1))) {
    if (row.ORACLE_MAINTAINED !== 'N' || row.SHARING !== 'NONE')
      unsupportedFeatures.push('Oracle-maintained or shared program');
    const type =
      row.OBJECT_TYPE === 'PACKAGE'
        ? 'PACKAGE_SPEC'
        : row.OBJECT_TYPE === 'PACKAGE BODY'
          ? 'PACKAGE_BODY'
          : (kind as 'FUNCTION' | 'PROCEDURE');
    const dependencies = await reader.rows(
      'program-dependencies',
      z.object({
        REFERENCED_OWNER: z.string(),
        REFERENCED_NAME: z.string(),
        REFERENCED_TYPE: z.string(),
        REFERENCED_LINK_NAME: z.string().nullable(),
        ORACLE_MAINTAINED: flag,
      }),
      `SELECT DISTINCT d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name,
          CASE WHEN d.referenced_link_name IS NOT NULL OR d.referenced_type='NON-EXISTENT' THEN 'N' ELSE o.oracle_maintained END AS oracle_maintained
        FROM ${reader.catalogView('dependencies')} d LEFT JOIN ${reader.catalogView('objects')} o
          ON o.owner=d.referenced_owner AND o.object_name=d.referenced_name AND o.object_type=d.referenced_type AND o.subobject_name IS NULL
        WHERE d.owner=:owner AND d.name=:name AND d.type=:type
        ORDER BY d.referenced_owner, d.referenced_name, d.referenced_type, d.referenced_link_name`,
      { ...binds, type: row.OBJECT_TYPE },
    );
    units.push({
      type,
      status: row.STATUS,
      ddl: await reader.programDdl(reference, type),
      dependencies: dependencies.map((edge) => ({
        reference: { owner: edge.REFERENCED_OWNER, name: edge.REFERENCED_NAME },
        type: edge.REFERENCED_TYPE,
        databaseLink: edge.REFERENCED_LINK_NAME,
        oracleMaintained: edge.ORACLE_MAINTAINED === 'Y',
      })),
    });
  }
  return { reference, kind, units, unsupportedFeatures };
}
