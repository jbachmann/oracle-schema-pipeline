import {
  qualifiedName,
  type ProgramDefinition,
  type ProgramUnit,
} from './model.js';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const catalogUnitType = (type: ProgramUnit['type']): string =>
  type === 'PACKAGE_SPEC'
    ? 'PACKAGE'
    : type === 'PACKAGE_BODY'
      ? 'PACKAGE BODY'
      : type;

/** ORA-24344 is the verified compilation warning; every other SQL error remains fatal. */
export function compilePrograms(programs: ProgramDefinition[]): string {
  const units = programs.flatMap((program) =>
    [...program.units]
      .sort((a, b) => (a.type < b.type ? 1 : a.type > b.type ? -1 : 0))
      .map((unit) => ({ program, unit })),
  );
  if (!units.length) return '';
  const predicate = ({ program, unit }: (typeof units)[number]) =>
    `owner=${literal(program.reference.owner)} AND object_name=${literal(program.reference.name)} AND object_type=${literal(catalogUnitType(unit.type))}`;
  const count = units
    .map(
      (item) =>
        `SELECT COUNT(*) INTO n FROM ALL_OBJECTS WHERE ${predicate(item)} AND status='VALID';\n    valid_count := valid_count + n;`,
    )
    .join('\n    ');
  const compile = units
    .map((item) => {
      const { program, unit } = item;
      const command = unit.type.startsWith('PACKAGE_')
        ? `ALTER PACKAGE ${qualifiedName(program.reference)} COMPILE ${unit.type === 'PACKAGE_SPEC' ? 'SPECIFICATION' : 'BODY'}`
        : `ALTER ${unit.type} ${qualifiedName(program.reference)} COMPILE`;
      return `SELECT COUNT(*) INTO n FROM ALL_OBJECTS WHERE ${predicate(item)} AND status='INVALID';\n    IF n > 0 THEN\n      BEGIN EXECUTE IMMEDIATE ${literal(command)};\n      EXCEPTION WHEN OTHERS THEN IF SQLCODE != -24344 THEN RAISE; END IF; END;\n    END IF;`;
    })
    .join('\n    ');
  const checks = units
    .map(
      (item) =>
        `SELECT COUNT(*) INTO n FROM ALL_OBJECTS WHERE ${predicate(item)} AND status='VALID';\n  IF n != 1 THEN RAISE_APPLICATION_ERROR(-20001, ${literal(`OSP_PROGRAM_INVALID ${qualifiedName(item.program.reference)} ${catalogUnitType(item.unit.type)}`)}); END IF;`,
    )
    .join('\n  ');
  return `DECLARE\n  n NUMBER;\n  valid_count PLS_INTEGER;\n  previous_count PLS_INTEGER := -1;\nBEGIN\n  FOR pass IN 1..${units.length + 1} LOOP\n    ${compile}\n    valid_count := 0;\n    ${count}\n    EXIT WHEN valid_count = ${units.length} OR valid_count <= previous_count;\n    previous_count := valid_count;\n  END LOOP;\n  ${checks}\nEND;\n/`;
}
