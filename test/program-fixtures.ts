import {
  policySchema,
  type ProgramUnit,
  type SequenceDefinition,
  type TargetDocument,
} from '../src/model.js';
import { sourceFixture } from './fixtures.js';
import { transformSource } from '../src/transform.js';
export const routineProperties = {
  deterministic: false,
  resultCache: false,
  pipelined: false,
  parallelEnabled: false,
  aggregate: false,
  sqlMacro: 'NONE' as const,
};
export function program(
  name = 'P',
  type: ProgramUnit['type'] = 'PROCEDURE',
  text?: string,
): ProgramUnit {
  return {
    reference: { owner: 'APP', name },
    type,
    sourceLines: [
      { line: 1, text: text ?? `${type} ${name} AS BEGIN NULL; END;` },
    ],
    status: 'VALID',
    editionable: true,
    editionName: null,
    authid: type === 'PACKAGE BODY' ? null : 'DEFINER',
    packageBodyPresent: type === 'PACKAGE' ? true : null,
    routineProperties: ['PROCEDURE', 'FUNCTION'].includes(type)
      ? { ...routineProperties }
      : null,
    members: [],
    dependencies: [],
    unsupportedFeatures: [],
    compilerSettings: {
      plsqlOptimizeLevel: 2,
      plsqlCodeType: 'INTERPRETED',
      plsqlDebug: false,
      plsqlWarnings: 'DISABLE:ALL',
      nlsLengthSemantics: 'BYTE',
      plsqlCcflags: null,
      plscopeSettings: 'IDENTIFIERS:NONE',
      plsqlImplicitConversionBool: false,
    },
  };
}
export function sequence(): SequenceDefinition {
  return {
    reference: { owner: 'APP', name: 'S' },
    minValue: '1',
    maxValue: '9999999999999999999999999999',
    incrementBy: '1',
    cacheSize: '20',
    lastNumber: '500',
    cycle: false,
    order: false,
    scale: false,
    extend: false,
    sharded: false,
    session: false,
    keep: false,
    sharing: 'NONE',
    identityBacking: false,
    unsupportedFeatures: [],
  };
}
export function programTarget(): TargetDocument {
  const source = sourceFixture();
  source.tables = [];
  source.targetTables = [];
  source.programUnits = [program()];
  source.targetProcedures = [source.programUnits[0].reference];
  return transformSource(source, policySchema.parse({}));
}
