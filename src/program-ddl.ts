import { qualifiedName, type ProgramUnit } from './model.js';
import { programDeclaration } from './programs.js';

export const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/** SQL*Plus-safe chunks preserve every character, including physical source newlines. */
export function clobAppendLines(text: string): string[] {
  const lines: string[] = [];
  let chunk = '';
  const flush = () => {
    if (chunk) {
      const literal = sqlLiteral(chunk);
      lines.push(
        `  DBMS_LOB.WRITEAPPEND(statement, LENGTH(${literal}), ${literal});`,
      );
      chunk = '';
    }
  };
  for (const character of text) {
    if (character === '\n' || character === '\r' || character === '\0') {
      flush();
      lines.push(
        `  DBMS_LOB.WRITEAPPEND(statement, 1, CHR(${character.charCodeAt(0)}));`,
      );
    } else {
      if (Buffer.byteLength(sqlLiteral(chunk + character), 'utf8') > 1000)
        flush();
      chunk += character;
    }
  }
  flush();
  return lines;
}

export function programAssertion(unit: ProgramUnit): string {
  return `DECLARE
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO n FROM all_objects WHERE owner=${sqlLiteral(unit.reference.owner)} AND object_name=${sqlLiteral(unit.reference.name)} AND object_type=${sqlLiteral(unit.type)} AND status='VALID';
  IF n<>1 THEN RAISE_APPLICATION_ERROR(-20000,'PROGRAM_COMPILATION_FAILED'); END IF;
  SELECT COUNT(*) INTO n FROM all_errors WHERE owner=${sqlLiteral(unit.reference.owner)} AND name=${sqlLiteral(unit.reference.name)} AND type=${sqlLiteral(unit.type)} AND attribute='ERROR';
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20000,'PROGRAM_COMPILATION_FAILED'); END IF;
END;
/`;
}

export function renderProgram(unit: ProgramUnit): string {
  const { statement } = programDeclaration(unit);
  const settings = unit.compilerSettings;
  const values: [string, string][] = [
    ['plsql_optimize_level', String(settings.plsqlOptimizeLevel)],
    ['plsql_code_type', 'INTERPRETED'],
    ['plsql_debug', settings.plsqlDebug ? 'TRUE' : 'FALSE'],
    ['plsql_warnings', 'ENABLE:ALL'],
    ['nls_length_semantics', settings.nlsLengthSemantics],
    ['plsql_ccflags', settings.plsqlCcflags ?? ''],
    ['plscope_settings', 'IDENTIFIERS:NONE'],
    [
      'plsql_implicit_conversion_bool',
      settings.plsqlImplicitConversionBool ? 'TRUE' : 'FALSE',
    ],
  ];
  return `-- Compile ${unit.type} ${qualifiedName(unit.reference)}.
DECLARE
  statement CLOB;
  cursor_id INTEGER;
  parameter_kind INTEGER;
  integer_value BINARY_INTEGER;
  captured PLS_INTEGER := 0;
${values.map((_, i) => `  saved_${i} VARCHAR2(32767);`).join('\n')}
  PROCEDURE set_parameter(name VARCHAR2, value VARCHAR2) IS
  BEGIN
    IF name IN ('plsql_debug','plsql_implicit_conversion_bool') THEN
      EXECUTE IMMEDIATE 'ALTER SESSION SET ' || name || '=' || CASE UPPER(value) WHEN 'TRUE' THEN 'TRUE' WHEN '1' THEN 'TRUE' ELSE 'FALSE' END;
    ELSE
      EXECUTE IMMEDIATE 'ALTER SESSION SET ' || name || '=' || CHR(39) || REPLACE(value,CHR(39),CHR(39)||CHR(39)) || CHR(39);
    END IF;
  END;
  PROCEDURE restore_settings IS
  BEGIN
${values.map(([name], i) => `    IF captured>${i} THEN set_parameter('${name}', saved_${i}); END IF;`).join('\n')}
  END;
BEGIN
${values
  .map(
    (
      [name],
      i,
    ) => `  parameter_kind := DBMS_UTILITY.GET_PARAMETER_VALUE('${name}', integer_value, saved_${i});
  IF parameter_kind=0 THEN saved_${i}:=TO_CHAR(integer_value); END IF;
  captured := ${i + 1};`,
  )
  .join('\n')}
${values.map(([name, value]) => `  set_parameter('${name}',${sqlLiteral(value)});`).join('\n')}
  DBMS_LOB.CREATETEMPORARY(statement, TRUE);
${clobAppendLines(statement).join('\n')}
  cursor_id := DBMS_SQL.OPEN_CURSOR;
  DBMS_SQL.PARSE(cursor_id, statement, DBMS_SQL.NATIVE);
  DBMS_SQL.CLOSE_CURSOR(cursor_id);
  DBMS_LOB.FREETEMPORARY(statement);
  restore_settings;
EXCEPTION WHEN OTHERS THEN
  IF cursor_id IS NOT NULL AND DBMS_SQL.IS_OPEN(cursor_id) THEN DBMS_SQL.CLOSE_CURSOR(cursor_id); END IF;
  IF DBMS_LOB.ISTEMPORARY(statement)=1 THEN DBMS_LOB.FREETEMPORARY(statement); END IF;
  restore_settings;
  RAISE_APPLICATION_ERROR(-20000,'PROGRAM_COMPILATION_FAILED',FALSE);
END;
/
${programAssertion(unit)}`;
}
