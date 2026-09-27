import type { ColumnDefinition, TargetPolicy } from './model.js';

/** Emit only known Oracle scalar types. Never treat an arbitrary type name as SQL. */
export function renderDataType(
  column: ColumnDefinition,
  policy: TargetPolicy,
): string {
  const type = column.dataType;
  if (type.owner) {
    throw new Error(
      `User-defined type ${type.owner}.${type.name} needs a dedicated renderer.`,
    );
  }

  const name = type.name.toUpperCase();
  if (
    [
      'DATE',
      'BINARY_FLOAT',
      'BINARY_DOUBLE',
      'CLOB',
      'NCLOB',
      'BLOB',
      'ROWID',
    ].includes(name)
  ) {
    return name;
  }

  if (name === 'NUMBER') {
    if (
      type.precision !== null &&
      (type.precision < 1 || type.precision > 38)
    ) {
      throw new Error('NUMBER precision must be 1..38.');
    }
    if (type.scale !== null && (type.scale < -84 || type.scale > 127)) {
      throw new Error('NUMBER scale is outside Oracle limits.');
    }
    if (type.precision === null && type.scale === null) {
      return 'NUMBER';
    }
    if (type.scale === null) {
      return `NUMBER(${type.precision})`;
    }
    return `NUMBER(${type.precision ?? '*'},${type.scale})`;
  }

  if (name === 'FLOAT') {
    if (type.precision === null) {
      return 'FLOAT';
    }
    if (type.precision < 1 || type.precision > 126) {
      throw new Error('FLOAT precision must be 1..126 binary digits.');
    }
    return `FLOAT(${type.precision})`;
  }

  if (['CHAR', 'VARCHAR2', 'NCHAR', 'NVARCHAR2'].includes(name)) {
    const national = name.startsWith('N');
    const length =
      national || type.lengthSemantics === 'CHAR'
        ? type.characterLength
        : type.byteLength;
    const varcharLimit = policy.maxStringSize === 'EXTENDED' ? 32767 : 4000;
    const maximumBytes =
      name === 'CHAR' || name === 'NCHAR' ? 2000 : varcharLimit;
    if (length < 1 || type.byteLength > maximumBytes) {
      throw new Error(`${name} exceeds the configured target byte limit.`);
    }
    if (!national && !type.lengthSemantics) {
      throw new Error(`${name} is missing BYTE/CHAR semantics.`);
    }
    return `${name}(${length}${national ? '' : ` ${type.lengthSemantics}`})`;
  }

  if (name === 'RAW' || name === 'UROWID') {
    const rawLimit = policy.maxStringSize === 'EXTENDED' ? 32767 : 2000;
    const maximumBytes = name === 'UROWID' ? 4000 : rawLimit;
    if (type.byteLength < 1 || type.byteLength > maximumBytes) {
      throw new Error(`${name} length is outside target limits.`);
    }
    return `${name}(${type.byteLength})`;
  }

  const timestamp =
    /^TIMESTAMP(?:\(([0-9])\))?( WITH(?: LOCAL)? TIME ZONE)?$/.exec(name);
  if (timestamp) {
    const [, embeddedPrecision, timeZoneSuffix] = timestamp;
    const precision = Number(embeddedPrecision ?? type.scale ?? 6);
    if (
      precision < 0 ||
      precision > 9 ||
      (type.scale !== null && (type.scale < 0 || type.scale > 9))
    ) {
      throw new Error(
        'TIMESTAMP fractional precision must be 0..9 and agree with scale.',
      );
    }
    if (
      embeddedPrecision !== undefined &&
      type.scale !== null &&
      precision !== type.scale
    ) {
      throw new Error(
        'TIMESTAMP fractional precision must be 0..9 and agree with scale.',
      );
    }
    return `TIMESTAMP(${precision})${timeZoneSuffix ?? ''}`;
  }

  // These names include their leading/fractional precision in Oracle's dictionary.
  if (
    /^INTERVAL YEAR\([0-9]\) TO MONTH$/.test(name) ||
    /^INTERVAL DAY\([0-9]\) TO SECOND\([0-9]\)$/.test(name)
  ) {
    return name;
  }

  throw new Error(`Unsupported Oracle datatype: ${type.name}.`);
}
