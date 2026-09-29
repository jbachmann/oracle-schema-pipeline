import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type SequenceDefinition,
  type TargetDocument,
} from './model.js';

export function sequenceStart(
  sequence: SequenceDefinition,
  document: Pick<TargetDocument, 'policy'>,
): string {
  return (
    document.policy.sequenceStarts.find(
      (item) => objectKey(item.reference) === objectKey(sequence.reference),
    )?.startWith ??
    (BigInt(sequence.incrementBy) > 0n ? sequence.minValue : sequence.maxValue)
  );
}

export function validateSequences(document: TargetDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, object: string, message: string) =>
    diagnostics.push({ severity: 'error' as const, code, object, message });
  const overrides = new Set<string>();
  for (const override of document.policy.sequenceStarts) {
    const key = objectKey(override.reference);
    if (
      overrides.has(key) ||
      !document.targetSequences.some((ref) => objectKey(ref) === key)
    )
      error(
        'INVALID_SEQUENCE_START',
        qualifiedName(override.reference),
        'Override must identify one explicitly selected sequence.',
      );
    overrides.add(key);
  }
  for (const sequence of document.sequences) {
    const object = qualifiedName(sequence.reference);
    if (
      sequence.scale ||
      sequence.extend ||
      sequence.sharded ||
      sequence.session ||
      sequence.identityBacking ||
      sequence.sharing !== 'NONE' ||
      sequence.unsupportedFeatures.length
    )
      error(
        'UNSUPPORTED_SEQUENCE',
        object,
        'Only conventional nonshared, nonmanaged global sequences are supported.',
      );
    const min = BigInt(sequence.minValue),
      max = BigInt(sequence.maxValue),
      increment = BigInt(sequence.incrementBy),
      cache = BigInt(sequence.cacheSize);
    const abs = increment < 0n ? -increment : increment;
    const validNumber = (value: bigint) =>
      value >= -(10n ** 27n - 1n) && value <= 10n ** 28n - 1n;
    if (
      ![min, max, increment].every(validNumber) ||
      min >= max ||
      increment === 0n ||
      abs >= max - min ||
      cache < 0n ||
      cache === 1n ||
      cache > 10n ** 28n - 1n ||
      (sequence.cycle &&
        abs > 0n &&
        cache > 0n &&
        cache >= (max - min + abs - 1n) / abs)
    )
      error(
        'INVALID_SEQUENCE',
        object,
        'Invalid bounds, increment, or cache for an Oracle sequence.',
      );
    const start = BigInt(sequenceStart(sequence, document));
    if (start < min || start > max)
      error(
        'INVALID_SEQUENCE_START',
        object,
        'Chosen restart is outside sequence bounds.',
      );
  }
  return diagnostics;
}

export function renderSequence(
  sequence: SequenceDefinition,
  document: Pick<TargetDocument, 'policy'>,
): string {
  return `CREATE SEQUENCE ${qualifiedName(sequence.reference)}\n  MINVALUE ${sequence.minValue} MAXVALUE ${sequence.maxValue}\n  INCREMENT BY ${sequence.incrementBy} START WITH ${sequenceStart(sequence, document)}\n  ${sequence.cacheSize === '0' ? 'NOCACHE' : `CACHE ${sequence.cacheSize}`} ${sequence.cycle ? 'CYCLE' : 'NOCYCLE'} ${sequence.order ? 'ORDER' : 'NOORDER'} ${sequence.keep ? 'KEEP' : 'NOKEEP'};`;
}
