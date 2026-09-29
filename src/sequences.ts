import { qualifiedName, type SequenceDefinition } from './model.js';

/** Exact arithmetic: Oracle sequence bounds exceed Number's integer precision. */
export function sequenceError(
  sequence: SequenceDefinition,
): string | undefined {
  const min = BigInt(sequence.minValue),
    max = BigInt(sequence.maxValue);
  const step = BigInt(sequence.incrementBy),
    cache = BigInt(sequence.cacheSize);
  const magnitude = step < 0n ? -step : step;
  if (min >= max || min < -(10n ** 27n - 1n) || max > 10n ** 28n - 1n)
    return 'Sequence bounds are outside supported Oracle limits.';
  if (
    step === 0n ||
    magnitude > max - min ||
    step < -(10n ** 27n - 1n) ||
    step > 10n ** 28n - 1n
  )
    return 'Increment must be nonzero and must not exceed the sequence range.';
  if (cache < 0n || cache === 1n || cache >= 10n ** 28n)
    return 'Cache must be zero or at least two within Oracle limits.';
  if (
    sequence.cycle &&
    cache > 0n &&
    cache > (max - min + magnitude - 1n) / magnitude
  )
    return 'Cyclic sequence cache must not exceed the supported cycle span.';
  return undefined;
}

export function renderSequence(sequence: SequenceDefinition): string {
  if (sequence.sharded || sequence.unsupportedFeatures.length)
    throw new Error('Unsupported sequence variant.');
  const error = sequenceError(sequence);
  if (error) throw new Error(error);
  const start =
    BigInt(sequence.incrementBy) > 0n ? sequence.minValue : sequence.maxValue;
  return `CREATE SEQUENCE ${qualifiedName(sequence.reference)}\n  MINVALUE ${sequence.minValue} MAXVALUE ${sequence.maxValue}\n  START WITH ${start} INCREMENT BY ${sequence.incrementBy}\n  ${sequence.cacheSize === '0' ? 'NOCACHE' : `CACHE ${sequence.cacheSize}`} ${sequence.cycle ? 'CYCLE' : 'NOCYCLE'} ${sequence.order ? 'ORDER' : 'NOORDER'}\n  ${sequence.scale ? `SCALE ${sequence.extend ? 'EXTEND' : 'NOEXTEND'}` : 'NOSCALE'}\n  ${sequence.session ? 'SESSION' : 'GLOBAL'} ${sequence.keep ? 'KEEP' : 'NOKEEP'};`;
}
