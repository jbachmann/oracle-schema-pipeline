import { objectKey, type TargetDocument } from './model.js';
import { sqlLiteral as literal, programAssertion } from './program-ddl.js';
import { objectGrants } from './object-grants.js';
import { resolveProvider } from './providers.js';

function check(from: string, expected = 1): string {
  return `DECLARE n NUMBER; BEGIN
  SELECT COUNT(*) INTO n FROM ${from};
  IF n<>${expected} THEN RAISE_APPLICATION_ERROR(-20000,'OBJECT_RECONSTRUCTION_FAILED'); END IF;
END;
/`;
}
/** Non-consuming catalog checks; allocation state is deliberately not compared. */
export function objectAssertions(
  document: TargetDocument,
  scope: 'all' | 'dba' = 'all',
): string[] {
  const sorted = <T>(items: T[], key: (item: T) => string): T[] =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const units = sorted(
    document.programUnits,
    (unit) => objectKey(unit.reference) + unit.type,
  );
  const result = units.map(programAssertion);
  for (const unit of units) {
    const identity = `owner=${literal(unit.reference.owner)} AND name=${literal(unit.reference.name)} AND type=${literal(unit.type)}`;
    const settings = unit.compilerSettings;
    result.push(
      check(
        `${scope}_plsql_object_settings WHERE ${identity} AND plsql_optimize_level=${settings.plsqlOptimizeLevel} AND plsql_code_type='INTERPRETED' AND plsql_debug='${settings.plsqlDebug ? 'TRUE' : 'FALSE'}' AND plsql_warnings='ENABLE:ALL' AND nls_length_semantics=${literal(settings.nlsLengthSemantics)} AND ${settings.plsqlCcflags ? `plsql_ccflags=${literal(settings.plsqlCcflags)}` : 'plsql_ccflags IS NULL'} AND plscope_settings='IDENTIFIERS:NONE' AND plsql_implicit_conversion_bool='${settings.plsqlImplicitConversionBool ? 'TRUE' : 'FALSE'}'`,
      ),
    );
    result.push(
      check(
        `${scope}_objects WHERE owner=${literal(unit.reference.owner)} AND object_name=${literal(unit.reference.name)} AND object_type=${literal(unit.type)} AND editionable='${unit.editionable ? 'Y' : 'N'}' AND edition_name IS NULL`,
      ),
    );
  }
  for (const unit of units)
    if (unit.type === 'PACKAGE' && !unit.packageBodyPresent)
      result.push(
        check(
          `${scope}_objects WHERE owner=${literal(unit.reference.owner)} AND object_name=${literal(unit.reference.name)} AND object_type='PACKAGE BODY'`,
          0,
        ),
      );
  for (const [roots, kind] of [
    [document.targetProcedures, 'PROCEDURE'],
    [document.targetFunctions, 'FUNCTION'],
  ] as const)
    for (const root of sorted(roots, (root) =>
      JSON.stringify([
        root.owner,
        'package' in root ? root.package : null,
        root.name,
      ]),
    )) {
      if (!('package' in root)) continue;
      result.push(
        check(
          `dual WHERE EXISTS (SELECT 1 FROM ${scope}_procedures p WHERE p.owner=${literal(root.owner)} AND p.object_name=${literal(root.package)} AND p.procedure_name=${literal(root.name)} AND ${kind === 'PROCEDURE' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${scope}_arguments a WHERE a.owner=p.owner AND a.package_name=p.object_name AND a.subprogram_id=p.subprogram_id AND a.position=0 AND a.data_level=0))`,
        ),
      );
    }
  for (const sequence of sorted(document.sequences, (item) =>
    objectKey(item.reference),
  )) {
    const predicates = [
      `sequence_owner=${literal(sequence.reference.owner)}`,
      `sequence_name=${literal(sequence.reference.name)}`,
      `min_value=${sequence.minValue}`,
      `max_value=${sequence.maxValue}`,
      `increment_by=${sequence.incrementBy}`,
      `cache_size=${sequence.cacheSize}`,
      ...(
        [
          ['cycle_flag', sequence.cycle],
          ['order_flag', sequence.order],
          ['keep_value', sequence.keep],
          ['scale_flag', false],
          ['extend_flag', false],
          ['sharded_flag', false],
          ['session_flag', false],
        ] as const
      ).map(([name, flag]) => `${name}='${flag ? 'Y' : 'N'}'`),
    ];
    result.push(check(`${scope}_sequences WHERE ${predicates.join(' AND ')}`));
  }
  for (const synonym of sorted(document.synonyms, (item) =>
    objectKey(item.reference),
  )) {
    result.push(
      check(
        `${scope}_synonyms WHERE owner=${literal(synonym.reference.owner)} AND synonym_name=${literal(synonym.reference.name)} AND table_owner=${literal(synonym.target.owner)} AND table_name=${literal(synonym.target.name)} AND db_link IS NULL`,
      ),
    );
    result.push(
      check(
        `${scope}_objects WHERE owner=${literal(synonym.reference.owner)} AND object_name=${literal(synonym.reference.name)} AND object_type='SYNONYM' AND editionable='${synonym.editionable ? 'Y' : 'N'}' AND edition_name IS NULL AND sharing='NONE'`,
      ),
    );
    const { provider } = resolveProvider(document, {
      reference: synonym.reference,
      type: 'SYNONYM',
      databaseLink: null,
    });
    if (provider)
      result.push(
        check(
          `${scope}_objects WHERE owner=${literal(provider.reference.owner)} AND object_name=${literal(provider.reference.name)} AND object_type=${literal(provider.type)} AND status='VALID'`,
        ),
      );
  }
  for (const grant of objectGrants(document).grants.filter(
    (grant) => scope === 'dba' || grant.explicit,
  ))
    result.push(
      check(
        `dual WHERE EXISTS (SELECT 1 FROM dba_tab_privs WHERE owner=${literal(grant.reference.owner)} AND table_name=${literal(grant.reference.name)} AND grantee=${literal(grant.grantee)} AND privilege=${literal(grant.privilege)})`,
      ),
    );
  for (const prerequisite of sorted(
    document.prerequisites,
    (item) => objectKey(item.reference) + objectKey(item.requiredBy),
  )) {
    if (!prerequisite.synonymResolution) continue;
    for (const link of prerequisite.synonymResolution.links)
      result.push(
        check(
          `${scope}_synonyms WHERE owner=${literal(link.reference.owner)} AND synonym_name=${literal(link.reference.name)} AND table_owner=${literal(link.target.owner)} AND table_name=${literal(link.target.name)} AND db_link IS NULL`,
        ),
      );
    const terminal = prerequisite.synonymResolution.terminal;
    result.push(
      check(
        `${scope}_objects WHERE owner=${literal(terminal.reference.owner)} AND object_name=${literal(terminal.reference.name)} AND object_type=${literal(terminal.type)} AND status='VALID'`,
      ),
    );
  }
  return result;
}
