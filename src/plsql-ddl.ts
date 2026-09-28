import { programSessionSettings } from './program-settings.js';
import type { ProgramSettings } from './model.js';
/** Source is transported as data: no source line can become a client command. */
import { renderSqlStringParts } from './comments.js';
import { type ObjectReference } from './model.js';
import { qualifyPlsqlSource, type ProgramUnitType } from './plsql.js';

export interface ProgramDdlInput {
  reference: ObjectReference;
  type: ProgramUnitType;
  source: string;
  editionable: boolean;
  /** Stable operation index used by orchestration; never embeds compiler TEXT. */
  operationIndex: number;
  settings?: ProgramSettings;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderProgramAssertion(
  reference: ObjectReference,
  type: ProgramUnitType,
  operationIndex: number,
): string {
  if (!Number.isSafeInteger(operationIndex) || operationIndex < 0)
    throw new Error('Invalid program operation index.');
  return `DECLARE
  n PLS_INTEGER;
  e PLS_INTEGER;
  ln PLS_INTEGER := 0;
  pos PLS_INTEGER := 0;
  msg PLS_INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO n FROM ALL_OBJECTS
   WHERE OWNER=${literal(reference.owner)} AND OBJECT_NAME=${literal(reference.name)}
     AND OBJECT_TYPE=${literal(type)} AND STATUS='VALID';
  SELECT COUNT(*) INTO e FROM ALL_ERRORS
   WHERE OWNER=${literal(reference.owner)} AND NAME=${literal(reference.name)}
     AND TYPE=${literal(type)} AND ATTRIBUTE='ERROR';
  IF e > 0 THEN
    SELECT line,position,message_number INTO ln,pos,msg FROM ALL_ERRORS
     WHERE OWNER=${literal(reference.owner)} AND NAME=${literal(reference.name)}
       AND TYPE=${literal(type)} AND ATTRIBUTE='ERROR'
     ORDER BY sequence FETCH FIRST 1 ROW ONLY;
  END IF;
  IF n <> 1 OR e <> 0 THEN
    RAISE_APPLICATION_ERROR(-20020, 'PLSQL_COMPILE_FAILED:${operationIndex}:' || ln || ':' || pos || ':' || msg);
  END IF;
END;
/
SELECT 'PLSQL_COMPILE_WARNING:${operationIndex}:' || line || ':' || position || ':' || message_number
  FROM ALL_ERRORS WHERE OWNER=${literal(reference.owner)} AND NAME=${literal(reference.name)}
   AND TYPE=${literal(type)} AND ATTRIBUTE='WARNING' ORDER BY sequence;`;
}

/** DBMS_SQL parses CLOB DDL directly; DDL must never be executed a second time. */
export function renderProgramDdl(input: ProgramDdlInput): string {
  const { reference, type, source, editionable, operationIndex } = input;
  const qualified = qualifyPlsqlSource(source, reference, type);
  const ddl = `CREATE ${editionable ? 'EDITIONABLE' : 'NONEDITIONABLE'} ${qualified}`;
  const pairs = input.settings ? programSessionSettings(input.settings) : [];
  const declarations = pairs
    .map((_, index) => `  baseline${index} VARCHAR2(4000);`)
    .join('\n');
  const capture = pairs
    .map(
      ([name], index) =>
        `  SELECT value INTO baseline${index} FROM v$parameter WHERE name='${name}';`,
    )
    .join('\n');
  const quotedSettings = new Set([
    'plsql_warnings',
    'plsql_ccflags',
    'plscope_settings',
  ]);
  const apply = pairs
    .map(
      ([name, value]) =>
        `  EXECUTE IMMEDIATE ${literal(`ALTER SESSION SET ${name}=${quotedSettings.has(name) ? literal(value) : value}`)};`,
    )
    .join('\n');
  const restore = pairs
    .map(([name], index) =>
      quotedSettings.has(name)
        ? `    EXECUTE IMMEDIATE 'ALTER SESSION SET ${name}=' || CHR(39) || REPLACE(baseline${index}, CHR(39), CHR(39)||CHR(39)) || CHR(39);`
        : `    EXECUTE IMMEDIATE 'ALTER SESSION SET ${name}=' || baseline${index};`,
    )
    .join('\n');
  const settingsProcedure = pairs.length
    ? `  settings_captured BOOLEAN := FALSE;\n  PROCEDURE restore_settings IS BEGIN\n    IF NOT settings_captured THEN RETURN; END IF;\n${restore}\n  END;`
    : '';
  const restoreCall = pairs.length ? '  restore_settings;' : '';
  const parts = renderSqlStringParts(ddl, true);
  const append = parts
    .map((part) => `  s := ${part};\n  DBMS_LOB.WRITEAPPEND(d, LENGTH(s), s);`)
    .join('\n');
  return `DECLARE
  d CLOB;
  c INTEGER;
  s VARCHAR2(32767);
${declarations}
${settingsProcedure}
BEGIN
${capture}
${pairs.length ? '  settings_captured := TRUE;' : ''}
${apply}
  DBMS_LOB.CREATETEMPORARY(d, TRUE);
${append}
  c := DBMS_SQL.OPEN_CURSOR;
  BEGIN
    DBMS_SQL.PARSE(c, d, DBMS_SQL.NATIVE);
  EXCEPTION WHEN OTHERS THEN
    IF SQLCODE <> -24344 THEN RAISE; END IF;
  END;
  DBMS_SQL.CLOSE_CURSOR(c);
  DBMS_LOB.FREETEMPORARY(d);
${restoreCall}
EXCEPTION
  WHEN OTHERS THEN
    BEGIN
      IF c IS NOT NULL THEN
        IF DBMS_SQL.IS_OPEN(c) THEN DBMS_SQL.CLOSE_CURSOR(c); END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      IF DBMS_LOB.ISTEMPORARY(d) = 1 THEN DBMS_LOB.FREETEMPORARY(d); END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
${
  pairs.length
    ? `    BEGIN
${restoreCall}
    EXCEPTION WHEN OTHERS THEN NULL;
    END;`
    : ''
}
    RAISE;
END;
/

${renderProgramAssertion(reference, type, operationIndex)}`;
}
