import { programSettingsSchema, type ProgramSettings } from './model.js';

/** Syntax validation is independent of quoting; unsupported settings fail closed. */
export function programSessionSettings(
  input: ProgramSettings,
): [string, string][] {
  const settings = programSettingsSchema.parse(input);
  if (
    !/^(?:\s*(?:ENABLE|DISABLE|ERROR)\s*:\s*(?:ALL|SEVERE|INFORMATIONAL|PERFORMANCE|\d{1,5})\s*)(?:,\s*(?:ENABLE|DISABLE|ERROR)\s*:\s*(?:ALL|SEVERE|INFORMATIONAL|PERFORMANCE|\d{1,5})\s*)*$/iu.test(
      settings.plsqlWarnings,
    )
  )
    throw new Error('UNSUPPORTED_PLSQL');
  if (
    !/^(?:\s*(?:IDENTIFIERS|STATEMENTS)\s*:\s*(?:ALL|NONE)\s*)(?:,\s*(?:IDENTIFIERS|STATEMENTS)\s*:\s*(?:ALL|NONE)\s*)*$/iu.test(
      settings.plscopeSettings,
    )
  )
    throw new Error('UNSUPPORTED_PLSQL');
  if (
    settings.plsqlCcflags &&
    !/^[a-z][a-z0-9_$#]*\s*:\s*(?:true|false|[+-]?\d+)(?:\s*,\s*[a-z][a-z0-9_$#]*\s*:\s*(?:true|false|[+-]?\d+))*$/iu.test(
      settings.plsqlCcflags,
    )
  )
    throw new Error('UNSUPPORTED_PLSQL');
  const pairs: [string, string][] = [
    ['plsql_code_type', settings.plsqlCodeType],
    ['plsql_debug', String(settings.plsqlDebug).toUpperCase()],
    ['plsql_optimize_level', String(settings.plsqlOptimizeLevel)],
    ['plsql_warnings', settings.plsqlWarnings],
    ['nls_length_semantics', settings.nlsLengthSemantics],
    ['plsql_ccflags', settings.plsqlCcflags ?? ''],
    ['plscope_settings', settings.plscopeSettings],
  ];
  if (pairs.some(([, value]) => Buffer.byteLength(value) > 1000))
    throw new Error('UNSUPPORTED_PLSQL');
  return pairs;
}
