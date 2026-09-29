import { z } from 'zod';
import {
  objectKey,
  qualifiedName,
  type ObjectReference,
  type Prerequisite,
  type SynonymDefinition,
} from './model.js';
import { catalogFailure, singleRow } from './catalog-decoding.js';
import type { CatalogReader, CatalogQuery } from './catalog-reader.js';

const rowSchema = z.object({
  TABLE_OWNER: z.string().min(1),
  TABLE_NAME: z.string().min(1),
  DB_LINK: z.string().nullable(),
  EDITIONABLE: z.enum(['Y', 'N']),
  EDITION_NAME: z.string().nullable(),
  SHARING: z.string(),
  TARGET_TYPE: z.string().min(1),
});
export async function readSynonyms(
  reader: CatalogReader,
  references: ObjectReference[],
): Promise<SynonymDefinition[]> {
  const query = {
    category: 'synonyms',
    schema: rowSchema,
    bindNames: ['owner', 'name'],
    sql: `SELECT s.table_owner,s.table_name,s.db_link,o.editionable,o.edition_name,o.sharing,t.object_type AS target_type
      FROM ${reader.catalogView('synonyms')} s
      JOIN ${reader.catalogView('objects')} o ON o.owner=s.owner AND o.object_name=s.synonym_name AND o.object_type='SYNONYM'
      LEFT JOIN ${reader.catalogView('objects')} t ON t.owner=s.table_owner AND t.object_name=s.table_name
        AND t.object_type IN ('TABLE','VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','SYNONYM','TYPE')
      /* selection */ WHERE s.owner=:owner AND s.synonym_name=:name`,
  } satisfies CatalogQuery<typeof rowSchema>;
  const rows = await reader.groupedRows(
    query,
    references.map((ref) => ({ owner: ref.owner, name: ref.name })),
  );
  return references.map((reference) => {
    const row = singleRow(
      rows.get(objectKey(reference))!,
      qualifiedName(reference),
      'synonym target',
    );
    return {
      reference,
      target: { owner: row.TABLE_OWNER, name: row.TABLE_NAME },
      databaseLink: row.DB_LINK,
      targetType: row.TARGET_TYPE,
      editionable: row.EDITIONABLE === 'Y',
      editionName: row.EDITION_NAME,
      sharing: row.SHARING,
      unsupportedFeatures: [],
    };
  });
}

export async function readSynonymResolution(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<NonNullable<Prerequisite['synonymResolution']>> {
  const links: NonNullable<Prerequisite['synonymResolution']>['links'] = [];
  const seen = new Set<string>();
  let next = reference;
  while (true) {
    if (seen.has(objectKey(next)))
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference),
        'synonym chain',
        'Cyclic synonym chain',
      );
    seen.add(objectKey(next));
    const [synonym] = await readSynonyms(reader, [next]);
    if (
      synonym.databaseLink ||
      synonym.reference.owner === 'PUBLIC' ||
      synonym.target.owner === 'PUBLIC' ||
      synonym.editionName ||
      synonym.sharing !== 'NONE'
    )
      catalogFailure(
        'CATALOG_INCOMPLETE_METADATA',
        qualifiedName(reference),
        'synonym chain',
        'Unsupported synonym resolution',
      );
    links.push({
      reference: next,
      target: synonym.target,
      databaseLink: synonym.databaseLink,
    });
    if (synonym.targetType !== 'SYNONYM')
      return {
        links,
        terminal: { reference: synonym.target, type: synonym.targetType },
      };
    next = synonym.target;
  }
}
