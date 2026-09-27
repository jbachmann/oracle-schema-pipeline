/**
 * Render extracted Oracle identity metadata as a column's GENERATED AS IDENTITY
 * clause. The DDL renderer uses this instead of the source's internal sequence
 * default, so generated SQL does not depend on the source sequence name.
 * This module works entirely from document metadata and never queries Oracle.
 */
import type { ColumnDefinition } from './model.js';

const supportedOptions = [
  'START WITH',
  'INCREMENT BY',
  'MIN_VALUE',
  'MAX_VALUE',
  'CACHE_SIZE',
  'CYCLE_FLAG',
  'ORDER_FLAG',
];
// These features have no SQL renderer yet. Accept their metadata only when
// disabled; silently dropping an enabled feature would change its behavior.
const disabledFeatureFlags = [
  'SCALE_FLAG',
  'EXTEND_FLAG',
  'SESSION_FLAG',
  'KEEP_VALUE',
  'SHARD_FLAG',
];
const recognizedOptions = [...supportedOptions, ...disabledFeatureFlags];

/** Parse comma-separated NAME: VALUE catalog entries and reject unsupported metadata. */
function parseIdentityOptions(raw: string): Map<string, string> {
  const options = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const match = /^\s*([A-Z_ ]+)\s*:\s*([^:]+?)\s*$/.exec(entry);
    if (!match || options.has(match[1].trim())) {
      throw new Error(`Unrecognized or duplicate identity option: ${entry}`);
    }
    options.set(match[1].trim(), match[2].trim());
  }

  for (const [name, value] of options) {
    if (!recognizedOptions.includes(name)) {
      throw new Error(`Unknown identity option: ${name}`);
    }
    if (disabledFeatureFlags.includes(name) && value !== 'N') {
      throw new Error(
        `Identity feature requires a dedicated renderer: ${name}=${value}`,
      );
    }
  }
  return options;
}

/**
 * Validate identity settings and return the SQL clause, or '' for a non-identity
 * column. Invalid or unknown options throw; the DDL preparation path reports
 * these as UNSUPPORTED_IDENTITY diagnostics that block generation.
 */
export function renderIdentity(column: ColumnDefinition): string {
  const identity = column.identity;
  if (!identity) {
    return '';
  }
  if (!['ALWAYS', 'BY DEFAULT'].includes(identity.generation)) {
    throw new Error(`Unknown identity generation: ${identity.generation}`);
  }
  if (identity.generation === 'ALWAYS' && column.defaultOnNull) {
    throw new Error('ALWAYS identity cannot also be BY DEFAULT ON NULL.');
  }

  const options = parseIdentityOptions(identity.options);
  const readInteger = (name: string): string => {
    const value = options.get(name);
    if (!value || !/^-?\d+$/.test(value)) {
      throw new Error(`Missing or invalid integer identity option: ${name}`);
    }
    return value;
  };
  const start = readInteger('START WITH');
  const increment = readInteger('INCREMENT BY');
  const minimum = readInteger('MIN_VALUE');
  const maximum = readInteger('MAX_VALUE');
  const cache = readInteger('CACHE_SIZE');

  // Sequence bounds can contain 28 digits, beyond JavaScript number precision.
  // Compare as bigint, but keep the original strings for lossless SQL output.
  const startValue = BigInt(start);
  const incrementValue = BigInt(increment);
  const minimumValue = BigInt(minimum);
  const maximumValue = BigInt(maximum);
  const cacheValue = BigInt(cache);
  if (
    incrementValue === 0n ||
    minimumValue >= maximumValue ||
    startValue < minimumValue ||
    startValue > maximumValue
  ) {
    throw new Error('Inconsistent identity sequence bounds or increment.');
  }
  if (cacheValue < 0n || cacheValue === 1n) {
    throw new Error('Identity cache must be zero or at least two.');
  }

  const renderFlag = (
    name: string,
    positive: string,
    negative: string,
  ): string => {
    const value = options.get(name);
    if (value !== 'Y' && value !== 'N') {
      throw new Error(`Missing or invalid identity flag: ${name}`);
    }
    return value === 'Y' ? positive : negative;
  };
  const generation =
    identity.generation + (column.defaultOnNull ? ' ON NULL' : '');
  const clauses = [
    `START WITH ${start}`,
    `INCREMENT BY ${increment}`,
    `MINVALUE ${minimum}`,
    `MAXVALUE ${maximum}`,
    cacheValue === 0n ? 'NOCACHE' : `CACHE ${cache}`,
    renderFlag('CYCLE_FLAG', 'CYCLE', 'NOCYCLE'),
    renderFlag('ORDER_FLAG', 'ORDER', 'NOORDER'),
  ];
  return `GENERATED ${generation} AS IDENTITY (${clauses.join(' ')})`;
}
