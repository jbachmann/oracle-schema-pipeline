import {
  objectKey,
  qualifiedName,
  quoteIdentifier,
  type Diagnostic,
  type SynonymDefinition,
  type TargetDocument,
} from './model.js';

export function renderSynonym(synonym: SynonymDefinition): string {
  const name =
    synonym.reference.owner === 'PUBLIC'
      ? `PUBLIC SYNONYM ${quoteIdentifier(synonym.reference.name)}`
      : `SYNONYM ${qualifiedName(synonym.reference)}`;
  return `CREATE ${synonym.editionable ? 'EDITIONABLE' : 'NONEDITIONABLE'} ${name} FOR ${qualifiedName(synonym.target)};`;
}

/** Offline verification of captured chain structure and agreement between selections. */
export function validateSynonyms(document: TargetDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const captured = new Map<string, string>();
  for (const synonym of document.synonyms) {
    const error = (code: string, message: string) =>
      diagnostics.push({
        severity: 'error' as const,
        code,
        object: qualifiedName(synonym.reference),
        message,
      });
    if (
      synonym.databaseLink !== null ||
      synonym.unsupportedFeatures.length ||
      (synonym.reference.owner === 'PUBLIC' && synonym.editionable)
    )
      error(
        'UNSUPPORTED_SYNONYM',
        'Remote, editioned public or unsupported synonyms cannot be generated.',
      );
    // Shared external hops must agree too, even when no alias definition is selected.
    for (const hop of [
      { reference: synonym.reference, type: 'SYNONYM', target: synonym.target },
      ...synonym.resolution,
    ]) {
      const key = objectKey(hop.reference);
      const signature = JSON.stringify([
        hop.type,
        hop.target && objectKey(hop.target),
      ]);
      if (captured.has(key) && captured.get(key) !== signature)
        error(
          'UNRESOLVED_SYNONYM_TARGET',
          'Captured chains disagree about a shared target.',
        );
      captured.set(key, signature);
    }
    const seen = new Set([objectKey(synonym.reference)]);
    let expected = synonym.target;
    for (const [index, hop] of synonym.resolution.entries()) {
      const key = objectKey(hop.reference);
      if (seen.has(key))
        error('SYNONYM_CYCLE', 'Synonym chain contains a loop.');
      seen.add(key);
      if (
        key !== objectKey(expected) &&
        !(
          hop.reference.owner === 'PUBLIC' &&
          hop.reference.name === expected.name
        )
      )
        error(
          'UNRESOLVED_SYNONYM_TARGET',
          'Resolution path disagrees with the recorded mapping.',
        );
      const last = index === synonym.resolution.length - 1;
      if (
        (hop.type === 'SYNONYM') !== (hop.target !== null) ||
        last === (hop.type === 'SYNONYM')
      )
        error(
          'UNRESOLVED_SYNONYM_TARGET',
          'Resolution must terminate at one supported non-synonym object.',
        );
      const selected = document.synonyms.find(
        (item) => objectKey(item.reference) === key,
      );
      if (
        selected &&
        (hop.type !== 'SYNONYM' ||
          !hop.target ||
          objectKey(selected.target) !== objectKey(hop.target) ||
          JSON.stringify(selected.resolution) !==
            JSON.stringify(synonym.resolution.slice(index + 1)))
      )
        error(
          'UNRESOLVED_SYNONYM_TARGET',
          'Selected aliases disagree about their target chain.',
        );
      if (hop.target) expected = hop.target;
    }
  }
  return diagnostics;
}

/** Exact aliases and chain targets; no application calls or synonym dereferencing. */
export function synonymChecks(
  document: Pick<TargetDocument, 'synonyms'>,
  scope: 'all' | 'dba',
): string[] {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const checks = new Set<string>();
  const mapping = (
    reference: SynonymDefinition['reference'],
    target: SynonymDefinition['target'],
  ) => {
    checks.add(
      `${scope}_synonyms WHERE owner=${literal(reference.owner)} AND synonym_name=${literal(reference.name)} AND table_owner=${literal(target.owner)} AND table_name=${literal(target.name)} AND db_link IS NULL`,
    );
  };
  for (const synonym of document.synonyms) {
    mapping(synonym.reference, synonym.target);
    checks.add(
      `${scope}_objects WHERE owner=${literal(synonym.reference.owner)} AND object_name=${literal(synonym.reference.name)} AND object_type='SYNONYM' AND editionable='${synonym.editionable ? 'Y' : 'N'}' AND edition_name IS NULL AND sharing='NONE'`,
    );
    let expected = synonym.target;
    for (const hop of synonym.resolution) {
      if (objectKey(expected) !== objectKey(hop.reference)) {
        // Absence requires complete DBA visibility, including in standalone replay.
        // A captured PUBLIC fallback must not be shadowed at the destination.
        checks.add(
          `dual WHERE NOT EXISTS (SELECT 1 FROM dba_objects WHERE owner=${literal(expected.owner)} AND object_name=${literal(expected.name)} AND object_type IN ('TABLE','VIEW','SEQUENCE','PACKAGE','PROCEDURE','FUNCTION','SYNONYM','TYPE','MATERIALIZED VIEW'))`,
        );
      }
      if (hop.target) {
        mapping(hop.reference, hop.target);
        expected = hop.target;
      } else {
        checks.add(
          `${scope}_objects WHERE owner=${literal(hop.reference.owner)} AND object_name=${literal(hop.reference.name)} AND object_type=${literal(hop.type)} AND status='VALID'`,
        );
      }
    }
  }
  return [...checks].sort();
}

export function verifySynonymsSql(
  document: Pick<TargetDocument, 'synonyms'>,
): string {
  return synonymChecks(document, 'all')
    .map(
      (from) =>
        `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${from}; IF n != 1 THEN RAISE_APPLICATION_ERROR(-20001, 'OSP_SYNONYM_INVALID'); END IF; END;\n/`,
    )
    .join('\n');
}
