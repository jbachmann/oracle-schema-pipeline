import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programTarget, sequence } from './program-fixtures.js';
import { generateSql } from '../src/generate.js';
import { resolveProvider } from '../src/providers.js';

test('private chains retain immediate aliases and require explicitly selected endpoints', () => {
  const target = programTarget(),
    seq = sequence();
  target.sequences = [seq];
  target.targetSequences = [seq.reference];
  target.synonyms = [
    {
      reference: { owner: 'APP', name: 'A' },
      target: { owner: 'APP', name: 'B' },
      targetType: 'SYNONYM',
      databaseLink: null,
      editionable: true,
      editionName: null,
      sharing: 'NONE',
      unsupportedFeatures: [],
    },
    {
      reference: { owner: 'APP', name: 'B' },
      target: seq.reference,
      targetType: 'SEQUENCE',
      databaseLink: null,
      editionable: true,
      editionName: null,
      sharing: 'NONE',
      unsupportedFeatures: [],
    },
  ];
  target.targetSynonyms = target.synonyms.map((item) => item.reference);
  assert.match(generateSql(target), /SYNONYM "APP"\."A" FOR "APP"\."B"/);
  const edge = {
    reference: target.synonyms[0].reference,
    type: 'SYNONYM',
    databaseLink: null,
  };
  assert.equal(resolveProvider(target, edge).provider?.type, 'SEQUENCE');
  target.synonyms[1].target = target.synonyms[0].reference;
  target.synonyms[1].targetType = 'SYNONYM';
  assert.throws(() => generateSql(target), /SYNONYM_DEPENDENCY_CYCLE/);
  target.synonyms.pop();
  target.targetSynonyms.pop();
  assert.throws(() => generateSql(target), /MISSING_SYNONYM_TARGET/);
});

test('self recursion through an alias does not create a false creation cycle', () => {
  const target = programTarget();
  const alias = {
    reference: { owner: 'APP', name: 'ALIAS' },
    target: target.programUnits[0].reference,
    targetType: 'PROCEDURE',
    databaseLink: null,
    editionable: true,
    editionName: null,
    sharing: 'NONE',
    unsupportedFeatures: [],
  };
  target.synonyms = [alias];
  target.targetSynonyms = [alias.reference];
  target.programUnits[0].dependencies = [
    {
      reference: alias.reference,
      type: 'SYNONYM',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  assert.doesNotThrow(() => generateSql(target));
});

test('external alias links require acknowledgment and exact captured resolution', () => {
  const target = programTarget();
  target.policy.createSchemas = false;
  const external = { owner: 'EXT', name: 'ALIAS' },
    endpoint = { owner: 'EXT', name: 'T' };
  target.programUnits[0].dependencies = [
    {
      reference: external,
      type: 'SYNONYM',
      databaseLink: null,
      oracleMaintained: false,
    },
  ];
  target.policy.externalPrerequisites = [
    { reference: external, type: 'SYNONYM' },
    { reference: endpoint, type: 'TABLE' },
  ];
  target.prerequisites = [
    {
      requiredBy: target.programUnits[0].reference,
      reference: external,
      type: 'SYNONYM',
      databaseLink: null,
      synonymResolution: {
        links: [{ reference: external, target: endpoint, databaseLink: null }],
        terminal: { reference: endpoint, type: 'TABLE' },
      },
    },
  ];
  assert.doesNotThrow(() => generateSql(target));
  target.prerequisites[0].synonymResolution!.links[0].databaseLink = 'REMOTE';
  assert.throws(() => generateSql(target), /UNSUPPORTED_SYNONYM/);
});
