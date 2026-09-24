import type { ColumnDefinition } from './model.js';

/** Normalize Oracle's IDENTITY_OPTIONS metadata without converting 28-digit
 * sequence bounds to JavaScript numbers. Unknown options block generation. */
export function renderIdentity(column: ColumnDefinition): string {
  const identity = column.identity;
  if (!identity) return '';
  if (!['ALWAYS', 'BY DEFAULT'].includes(identity.generation))
    throw new Error(`Unknown identity generation: ${identity.generation}`);
  if (identity.generation === 'ALWAYS' && column.defaultOnNull)
    throw new Error('ALWAYS identity cannot also be BY DEFAULT ON NULL.');
  const options = new Map<string, string>();
  for (const entry of identity.options.split(',')) {
    const match = /^\s*([A-Z_ ]+)\s*:\s*([^:]+?)\s*$/.exec(entry);
    if (!match || options.has(match[1].trim()))
      throw new Error(`Unrecognized or duplicate identity option: ${entry}`);
    options.set(match[1].trim(), match[2].trim());
  }
  const recognizedOptions = [
    'START WITH',
    'INCREMENT BY',
    'MIN_VALUE',
    'MAX_VALUE',
    'CACHE_SIZE',
    'CYCLE_FLAG',
    'ORDER_FLAG',
    'SCALE_FLAG',
    'EXTEND_FLAG',
    'SESSION_FLAG',
    'KEEP_VALUE',
    'SHARD_FLAG',
  ];
  for (const [name, value] of options) {
    if (!recognizedOptions.includes(name))
      throw new Error(`Unknown identity option: ${name}`);
    if (
      [
        'SCALE_FLAG',
        'EXTEND_FLAG',
        'SESSION_FLAG',
        'KEEP_VALUE',
        'SHARD_FLAG',
      ].includes(name) &&
      value !== 'N'
    ) {
      throw new Error(
        `Identity feature requires a dedicated renderer: ${name}=${value}`,
      );
    }
  }
  const integer = (name: string): string => {
    const value = options.get(name);
    if (!value || !/^-?\d+$/.test(value))
      throw new Error(`Missing or invalid integer identity option: ${name}`);
    return value;
  };
  const start = integer('START WITH'),
    increment = integer('INCREMENT BY'),
    minimum = integer('MIN_VALUE'),
    maximum = integer('MAX_VALUE');
  const cache = integer('CACHE_SIZE');
  if (
    BigInt(increment) === 0n ||
    BigInt(minimum) >= BigInt(maximum) ||
    BigInt(start) < BigInt(minimum) ||
    BigInt(start) > BigInt(maximum)
  ) {
    throw new Error('Inconsistent identity sequence bounds or increment.');
  }
  if (BigInt(cache) < 0n || BigInt(cache) === 1n)
    throw new Error('Identity cache must be zero or at least two.');
  const flag = (name: string, positive: string, negative: string): string => {
    const value = options.get(name);
    if (value !== 'Y' && value !== 'N')
      throw new Error(`Missing or invalid identity flag: ${name}`);
    return value === 'Y' ? positive : negative;
  };
  const generation =
    identity.generation + (column.defaultOnNull ? ' ON NULL' : '');
  return `GENERATED ${generation} AS IDENTITY (START WITH ${start} INCREMENT BY ${increment} MINVALUE ${minimum} MAXVALUE ${maximum} ${BigInt(cache) === 0n ? 'NOCACHE' : `CACHE ${cache}`} ${flag('CYCLE_FLAG', 'CYCLE', 'NOCYCLE')} ${flag('ORDER_FLAG', 'ORDER', 'NOORDER')})`;
}
