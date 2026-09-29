import { z } from 'zod';
import type { CatalogReader } from './catalog-reader.js';
import { catalogFailure } from './catalog-decoding.js';
import {
  objectKey,
  qualifiedName,
  synonymTargetTypeSchema,
  type ObjectReference,
  type SynonymDefinition,
} from './model.js';

const objectRow = z.object({
  OBJECT_TYPE: z.string(),
  ORACLE_MAINTAINED: z.enum(['Y', 'N']),
  SHARING: z.string(),
  EDITION_NAME: z.string().nullable(),
  EDITIONABLE: z.enum(['Y', 'N']).nullable(),
});
const mappingRow = z.object({
  TABLE_OWNER: z.string().min(1).nullable(),
  TABLE_NAME: z.string().min(1),
  DB_LINK: z.string().nullable(),
});

/** Read only explicitly named aliases; inspect chains without exporting their objects. */
export async function readSynonym(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<SynonymDefinition> {
  const fail = (
    code:
      | 'SYNONYM_METADATA_UNAVAILABLE'
      | 'UNRESOLVED_SYNONYM_TARGET'
      | 'UNSUPPORTED_SYNONYM'
      | 'SYNONYM_CYCLE',
    ref: ObjectReference,
    detail: string,
  ): never => catalogFailure(code, qualifiedName(ref), 'synonym', detail);
  const objects = (ref: ObjectReference) =>
    reader.rows(
      'synonyms',
      objectRow,
      `SELECT object_type, oracle_maintained, sharing, edition_name, editionable
     FROM ${reader.catalogView('objects')} WHERE owner=:owner AND object_name=:name
       AND subobject_name IS NULL AND object_type NOT IN
       ('PACKAGE BODY','TYPE BODY','INDEX','TRIGGER','LOB','TABLE PARTITION','INDEX PARTITION')`,
      { owner: ref.owner, name: ref.name },
    );
  const mapping = async (ref: ObjectReference) => {
    const rows = await reader.rows(
      'synonyms',
      mappingRow,
      `SELECT table_owner, table_name, db_link FROM ${reader.catalogView('synonyms')}
       WHERE owner=:owner AND synonym_name=:name`,
      { owner: ref.owner, name: ref.name },
    );
    if (rows.length !== 1)
      fail(
        'SYNONYM_METADATA_UNAVAILABLE',
        ref,
        'Require exactly one visible synonym mapping; check catalog scope and privileges.',
      );
    if (rows[0].DB_LINK !== null)
      fail(
        'UNSUPPORTED_SYNONYM',
        ref,
        'Database-link targets are unsupported.',
      );
    const row = rows[0];
    if (row.TABLE_OWNER === null)
      return fail(
        'UNRESOLVED_SYNONYM_TARGET',
        ref,
        'Local target owner is missing.',
      );
    return { owner: row.TABLE_OWNER, name: row.TABLE_NAME };
  };
  const root = await objects(reference);
  if (root.length !== 1 || root[0].OBJECT_TYPE !== 'SYNONYM')
    fail(
      'SYNONYM_METADATA_UNAVAILABLE',
      reference,
      'Selected synonym is missing, ambiguous or inaccessible.',
    );
  if (
    root[0].ORACLE_MAINTAINED !== 'N' ||
    root[0].SHARING !== 'NONE' ||
    root[0].EDITION_NAME !== null
  )
    fail(
      'UNSUPPORTED_SYNONYM',
      reference,
      'Oracle-maintained, common and edition-specific synonyms are unsupported.',
    );
  if (root[0].EDITIONABLE === null)
    fail(
      'SYNONYM_METADATA_UNAVAILABLE',
      reference,
      'Missing editionability metadata.',
    );
  const target = await mapping(reference);
  const resolution: SynonymDefinition['resolution'] = [];
  const seen = new Set([objectKey(reference)]);
  let current = target;
  while (true) {
    // PUBLIC fallback cannot safely be inferred from absence in ALL_OBJECTS:
    // absence may mean insufficient visibility. Require DBA scope for that case.
    let rows = await objects(current);
    if (
      !rows.length &&
      current.owner !== 'PUBLIC' &&
      reader.catalogView('objects') === 'dba_objects'
    ) {
      const publicRef = { owner: 'PUBLIC', name: current.name };
      const fallback = await objects(publicRef);
      if (fallback.length === 1 && fallback[0].OBJECT_TYPE === 'SYNONYM') {
        current = publicRef;
        rows = fallback;
      }
    }
    if (seen.has(objectKey(current)))
      fail('SYNONYM_CYCLE', reference, 'Synonym chain contains a loop.');
    seen.add(objectKey(current));
    if (rows.length !== 1)
      fail(
        'UNRESOLVED_SYNONYM_TARGET',
        current,
        'Target is missing, ambiguous or inaccessible; use an authorized DBA catalog reader if needed.',
      );
    const row = rows[0];
    const type = synonymTargetTypeSchema.safeParse(row.OBJECT_TYPE);
    if (!type.success)
      return fail('UNSUPPORTED_SYNONYM', current, 'Unsupported target type.');
    if (row.SHARING !== 'NONE' || row.EDITION_NAME !== null)
      fail(
        'UNSUPPORTED_SYNONYM',
        current,
        'Unsupported target type, sharing or edition.',
      );
    const next = type.data === 'SYNONYM' ? await mapping(current) : null;
    resolution.push({ reference: current, type: type.data, target: next });
    if (!next) break;
    current = next;
  }
  return {
    reference,
    target,
    databaseLink: null,
    editionable: root[0].EDITIONABLE === 'Y',
    resolution,
    unsupportedFeatures: [],
  };
}
