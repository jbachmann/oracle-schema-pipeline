import { z } from 'zod';
import {
  decimalIntegerSchema,
  objectKey,
  qualifiedName,
  type ObjectReference,
  type SequenceDefinition,
} from './model.js';
import { singleRow } from './catalog-decoding.js';
import type { CatalogReader, CatalogQuery } from './catalog-reader.js';

const flag = z.enum(['Y', 'N']);
const sequenceRow = z.object({
  MIN_VALUE: decimalIntegerSchema,
  MAX_VALUE: decimalIntegerSchema,
  INCREMENT_BY: decimalIntegerSchema,
  CACHE_SIZE: decimalIntegerSchema,
  LAST_NUMBER: decimalIntegerSchema,
  CYCLE_FLAG: flag,
  ORDER_FLAG: flag,
  SCALE_FLAG: flag,
  EXTEND_FLAG: flag,
  SHARDED_FLAG: flag,
  SESSION_FLAG: flag,
  KEEP_VALUE: flag,
  SHARING: z.enum(['NONE', 'METADATA LINK', 'DATA LINK']),
  ORACLE_MAINTAINED: flag,
  OBJECT_MAINTAINED: flag,
  GENERATED: flag,
  IDENTITY_COUNT: z.number().int().nonnegative(),
});

export async function readSequences(
  reader: CatalogReader,
  references: ObjectReference[],
): Promise<SequenceDefinition[]> {
  const exact = (column: string) =>
    `TO_CHAR(s.${column}, 'FM99999999999999999999999999999999999999', 'NLS_NUMERIC_CHARACTERS=''.,''') AS ${column}`;
  const query = {
    category: 'sequences',
    schema: sequenceRow,
    bindNames: ['owner', 'name'],
    sql: `SELECT ${['MIN_VALUE', 'MAX_VALUE', 'INCREMENT_BY', 'CACHE_SIZE', 'LAST_NUMBER'].map(exact).join(', ')},
      s.cycle_flag,s.order_flag,s.scale_flag,s.extend_flag,s.sharded_flag,s.session_flag,s.keep_value,
      o.sharing,u.oracle_maintained,o.oracle_maintained AS object_maintained,o.generated,
      (SELECT COUNT(*) FROM ${reader.catalogView('tabIdentityCols')} c WHERE c.owner=s.sequence_owner AND c.sequence_name=s.sequence_name) AS identity_count
      FROM ${reader.catalogView('sequences')} s
      JOIN ${reader.catalogView('objects')} o ON o.owner=s.sequence_owner AND o.object_name=s.sequence_name AND o.object_type='SEQUENCE'
      JOIN ${reader.catalogView('users')} u ON u.username=s.sequence_owner
      /* selection */ WHERE s.sequence_owner=:owner AND s.sequence_name=:name`,
  } satisfies CatalogQuery<typeof sequenceRow>;
  const rows = await reader.groupedRows(
    query,
    references.map((ref) => ({ owner: ref.owner, name: ref.name })),
  );
  return references.map((reference) => {
    const row = singleRow(
      rows.get(objectKey(reference))!,
      qualifiedName(reference),
      'sequence',
    );
    return {
      reference,
      minValue: row.MIN_VALUE,
      maxValue: row.MAX_VALUE,
      incrementBy: row.INCREMENT_BY,
      cacheSize: row.CACHE_SIZE,
      lastNumber: row.LAST_NUMBER,
      cycle: row.CYCLE_FLAG === 'Y',
      order: row.ORDER_FLAG === 'Y',
      scale: row.SCALE_FLAG === 'Y',
      extend: row.EXTEND_FLAG === 'Y',
      sharded: row.SHARDED_FLAG === 'Y',
      session: row.SESSION_FLAG === 'Y',
      keep: row.KEEP_VALUE === 'Y',
      sharing: row.SHARING,
      identityBacking: row.IDENTITY_COUNT > 0,
      unsupportedFeatures:
        row.ORACLE_MAINTAINED === 'Y' ||
        row.OBJECT_MAINTAINED === 'Y' ||
        row.GENERATED === 'Y'
          ? ['Oracle-maintained or generated sequence']
          : [],
    };
  });
}
