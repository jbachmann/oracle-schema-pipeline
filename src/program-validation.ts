import { allPrerequisites, includedType } from './dependencies.js';
import { sequenceError } from './sequences.js';
import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type TargetDocument,
} from './model.js';

export function validateProgramsAndSequences(
  document: TargetDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, object: string, message: string) =>
    diagnostics.push({ severity: 'error', code, object, message });
  const seen = new Set<string>();
  for (const item of [
    ...document.tables,
    ...document.views,
    ...document.programs,
    ...document.sequences,
  ]) {
    const key = objectKey(item.reference);
    if (seen.has(key))
      error(
        'OBJECT_NAME_COLLISION',
        qualifiedName(item.reference),
        'Included definitions share a schema namespace.',
      );
    seen.add(key);
  }
  for (const [kind, roots] of [
    ['PACKAGE', document.targetPackages],
    ['PROCEDURE', document.targetProcedures],
    ['FUNCTION', document.targetFunctions],
    ['SEQUENCE', document.targetSequences],
  ] as const) {
    const keys = new Set<string>();
    for (const root of roots) {
      if (keys.has(objectKey(root)))
        error(
          'OBJECT_NAME_COLLISION',
          qualifiedName(root),
          'Duplicate selected identity.',
        );
      keys.add(objectKey(root));
      if (includedType(document, root) !== kind)
        error(
          'MISSING_TARGET',
          qualifiedName(root),
          `Selected ${kind} definition is absent.`,
        );
    }
    for (const item of kind === 'SEQUENCE'
      ? document.sequences
      : document.programs.filter((p) => p.kind === kind)) {
      if (!keys.has(objectKey(item.reference)))
        error(
          'MISSING_TARGET',
          qualifiedName(item.reference),
          'Programs and sequences must be explicitly selected.',
        );
    }
  }
  for (const prerequisite of document.prerequisites) {
    if (prerequisite.origin !== 'INDEX') continue;
    const table = document.tables.find(
      (item) =>
        objectKey(item.reference) === objectKey(prerequisite.requiredBy),
    );
    if (
      !table?.indexes.some((index) =>
        index.dependencies.some(
          (edge) =>
            edge.type === prerequisite.type &&
            edge.databaseLink === prerequisite.databaseLink &&
            objectKey(edge.reference) === objectKey(prerequisite.reference),
        ),
      )
    )
      error(
        'UNSUPPORTED_INDEX_DEPENDENCY',
        qualifiedName(prerequisite.requiredBy),
        'Index-origin prerequisite must match an included index dependency.',
      );
  }
  for (const edge of allPrerequisites(document)) {
    const included = includedType(document, edge.reference);
    if (!edge.databaseLink && included && included !== edge.type)
      error(
        'INVALID_PROGRAM_UNITS',
        qualifiedName(edge.requiredBy),
        'Dependency identity disagrees with the included object type.',
      );
  }
  for (const program of document.programs) {
    const name = qualifiedName(program.reference);
    const types = program.units.map((unit) => unit.type);
    if (
      new Set(types).size !== types.length ||
      (program.kind === 'PACKAGE'
        ? !types.includes('PACKAGE_SPEC') ||
          types.some((type) => !['PACKAGE_SPEC', 'PACKAGE_BODY'].includes(type))
        : types.length !== 1 || types[0] !== program.kind)
    )
      error(
        'INVALID_PROGRAM_UNITS',
        name,
        'Program units must agree with kind; packages require one specification and at most one body.',
      );
    for (const feature of program.unsupportedFeatures)
      error('UNSUPPORTED_FEATURE', name, feature);
    for (const unit of program.units) {
      if (unit.status === 'INVALID')
        diagnostics.push({
          severity: 'warning',
          code: 'SOURCE_PROGRAM_INVALID',
          object: name,
          message: `${unit.type} is invalid in the source; destination compilation must succeed.`,
        });
      const dependencyTypes = new Map<string, string>();
      for (const edge of unit.dependencies) {
        const key = JSON.stringify([
          objectKey(edge.reference),
          edge.databaseLink,
        ]);
        const previous = dependencyTypes.get(key);
        const included = includedType(document, edge.reference);
        if (
          (previous && previous !== edge.type) ||
          (!edge.databaseLink && included && included !== edge.type)
        )
          error(
            'INVALID_PROGRAM_UNITS',
            name,
            'Dependency identity has inconsistent object types.',
          );
        dependencyTypes.set(key, edge.type);
      }
    }
  }
  for (const sequence of document.sequences) {
    const name = qualifiedName(sequence.reference);
    const detail = sequenceError(sequence);
    if (detail) error('INVALID_SEQUENCE', name, detail);
    for (const feature of sequence.unsupportedFeatures)
      error('UNSUPPORTED_SEQUENCE_FEATURE', name, feature);
    if (sequence.sharded)
      error(
        'UNSUPPORTED_SEQUENCE_FEATURE',
        name,
        'Shard DDL is disabled on the pinned destination.',
      );
    if (
      (sequence.extend && !sequence.scale) ||
      (sequence.session &&
        (sequence.scale || sequence.keep || sequence.cycle || sequence.order))
    )
      error(
        'UNSUPPORTED_SEQUENCE_FEATURE',
        name,
        'Unverified or ineffective sequence option combination.',
      );
  }
  return diagnostics;
}
