import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programTarget, sequence } from './program-fixtures.js';
import {
  sequenceStart,
  validateSequences,
  renderSequence,
} from '../src/sequences.js';
import { generateSql } from '../src/generate.js';

test('sequence restarts use exact direction bounds or selected policy overrides, never allocation state', () => {
  const target = programTarget(),
    seq = sequence();
  target.sequences = [seq];
  target.targetSequences = [seq.reference];
  assert.equal(sequenceStart(seq, target), '1');
  seq.lastNumber = '99999999999999999999999999999';
  assert.equal(sequenceStart(seq, target), '1');
  seq.minValue = '-999';
  seq.maxValue = '-1';
  seq.incrementBy = '-2';
  assert.equal(sequenceStart(seq, target), '-1');
  target.policy.sequenceStarts = [
    { reference: seq.reference, startWith: '-501' },
  ];
  assert.equal(sequenceStart(seq, target), '-501');
  assert.match(renderSequence(seq, target), /START WITH -501/);
  assert.doesNotThrow(() => generateSql(target));
});

test('sequence bounds, increments, cache combinations, starts, and unsupported features fail closed', () => {
  for (const changes of [
    { incrementBy: '0' },
    { cacheSize: '1' },
    { minValue: '5', maxValue: '1' },
    { cycle: true, maxValue: '10', cacheSize: '20' },
    { scale: true },
    { identityBacking: true },
    { minValue: '-9999999999999999999999999999' },
  ]) {
    const target = programTarget();
    target.sequences = [{ ...sequence(), ...changes }];
    target.targetSequences = [target.sequences[0].reference];
    assert.ok(validateSequences(target).some((d) => d.severity === 'error'));
  }
  const target = programTarget();
  target.sequences = [sequence()];
  target.targetSequences = [sequence().reference];
  target.policy.sequenceStarts = [
    { reference: sequence().reference, startWith: '0' },
  ];
  assert.throws(() => generateSql(target), /INVALID_SEQUENCE_START/);
  target.policy.sequenceStarts.push({ ...target.policy.sequenceStarts[0] });
  assert.ok(validateSequences(target).length >= 2);
});
