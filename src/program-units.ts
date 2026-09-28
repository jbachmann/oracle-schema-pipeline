import type { TargetDocument } from './model.js';
/** Stable indices shared by generated assertions and safe failure mapping. */
export function orderedProgramUnits(
  document: Pick<TargetDocument, 'programs'>,
) {
  return document.programs
    .flatMap((program) => program.units.map((unit) => ({ program, unit })))
    .sort((left, right) => {
      const a = JSON.stringify([
        left.program.reference.owner,
        left.program.reference.name,
        left.unit.type,
      ]);
      const b = JSON.stringify([
        right.program.reference.owner,
        right.program.reference.name,
        right.unit.type,
      ]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
