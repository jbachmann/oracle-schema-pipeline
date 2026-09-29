import { requireMetadataVisibility } from './catalog-programs.js';
import { z } from 'zod';
import type { CatalogReader } from './catalog-reader.js';
import { catalogFailure, singleRow } from './catalog-decoding.js';
import {
  qualifiedName,
  type ObjectReference,
  type SequenceDefinition,
} from './model.js';
const flag = z.enum(['Y', 'N']);
const integer = z.string().regex(/^-?[0-9]+$/);
export async function readSequence(
  reader: CatalogReader,
  reference: ObjectReference,
): Promise<SequenceDefinition> {
  await requireMetadataVisibility(reader, reference);
  const row = singleRow(
    await reader.rows(
      'sequences',
      z.object({
        MIN_VALUE: integer,
        MAX_VALUE: integer,
        INCREMENT_BY: integer,
        CACHE_SIZE: integer,
        CYCLE_FLAG: flag,
        ORDER_FLAG: flag,
        SCALE_FLAG: flag,
        EXTEND_FLAG: flag,
        SHARDED_FLAG: flag,
        SESSION_FLAG: flag,
        KEEP_VALUE: flag,
        ORACLE_MAINTAINED: flag,
        SHARING: z.string(),
        IDENTITY_COUNT: z.number().int(),
      }),
      `SELECT to_char(s.min_value, 'TM9') AS min_value, to_char(s.max_value, 'TM9') AS max_value,
      to_char(s.increment_by, 'TM9') AS increment_by, to_char(s.cache_size, 'TM9') AS cache_size,
      s.cycle_flag, s.order_flag, s.scale_flag, s.extend_flag, s.sharded_flag, s.session_flag, s.keep_value,
      o.oracle_maintained, o.sharing,
      (SELECT count(*) FROM ${reader.catalogView('tabIdentityCols')} i WHERE i.owner=s.sequence_owner AND i.sequence_name=s.sequence_name) AS identity_count
    FROM ${reader.catalogView('sequences')} s JOIN ${reader.catalogView('objects')} o
      ON o.owner=s.sequence_owner AND o.object_name=s.sequence_name AND o.object_type='SEQUENCE'
    WHERE s.sequence_owner=:owner AND s.sequence_name=:name`,
      { owner: reference.owner, name: reference.name },
    ),
    qualifiedName(reference),
    'sequence',
  );
  if (row.IDENTITY_COUNT)
    catalogFailure(
      'INVALID_SEQUENCE',
      qualifiedName(reference),
      'identity',
      'Identity-owned sequences must be extracted through their table.',
    );
  return {
    reference,
    minValue: row.MIN_VALUE,
    maxValue: row.MAX_VALUE,
    incrementBy: row.INCREMENT_BY,
    cacheSize: row.CACHE_SIZE,
    cycle: row.CYCLE_FLAG === 'Y',
    order: row.ORDER_FLAG === 'Y',
    scale: row.SCALE_FLAG === 'Y',
    extend: row.EXTEND_FLAG === 'Y',
    sharded: row.SHARDED_FLAG === 'Y',
    session: row.SESSION_FLAG === 'Y',
    keep: row.KEEP_VALUE === 'Y',
    unsupportedFeatures:
      row.ORACLE_MAINTAINED !== 'N' || row.SHARING !== 'NONE'
        ? ['Oracle-maintained or application-common sequence']
        : [],
  };
}
