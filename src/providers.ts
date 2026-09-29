import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type ObjectReference,
  type TargetDocument,
  type ViewDependency,
} from './model.js';

export interface Provider {
  reference: ObjectReference;
  type: string;
  external: boolean;
}
export function providerIndex(document: TargetDocument): Map<string, Provider> {
  const result = new Map<string, Provider>();
  for (const item of document.policy.externalPrerequisites)
    result.set(objectKey(item.reference), { ...item, external: true });
  for (const [definitions, type] of [
    [document.tables, 'TABLE'],
    [document.views, 'VIEW'],
    [document.sequences, 'SEQUENCE'],
    [document.synonyms, 'SYNONYM'],
  ] as const) {
    for (const item of definitions)
      result.set(objectKey(item.reference), {
        reference: item.reference,
        type,
        external: false,
      });
  }
  for (const unit of document.programUnits)
    if (unit.type !== 'PACKAGE BODY')
      result.set(objectKey(unit.reference), {
        reference: unit.reference,
        type: unit.type,
        external: false,
      });
  return result;
}

export function resolveProvider(
  document: TargetDocument,
  edge: ViewDependency,
): { provider?: Provider; aliases: ObjectReference[]; error?: string } {
  const providers = providerIndex(document);
  const aliases: ObjectReference[] = [];
  const seen = new Set<string>();
  let reference = edge.reference,
    type = edge.type;
  if (edge.databaseLink) return { aliases, error: 'REMOTE_PREREQUISITE' };
  while (true) {
    const key = objectKey(reference);
    if (seen.has(key)) return { aliases, error: 'SYNONYM_DEPENDENCY_CYCLE' };
    seen.add(key);
    const provider = providers.get(key);
    if (!provider || provider.type !== type)
      return {
        aliases,
        error:
          aliases.length || type === 'SYNONYM'
            ? 'MISSING_SYNONYM_TARGET'
            : 'UNACKNOWLEDGED_PREREQUISITE',
      };
    if (type !== 'SYNONYM') return { provider, aliases };
    aliases.push(reference);
    if (reference.owner === 'PUBLIC')
      return { aliases, error: 'UNSUPPORTED_SYNONYM' };
    const selected = document.synonyms.find(
      (item) => objectKey(item.reference) === key,
    );
    if (selected) {
      if (
        selected.databaseLink ||
        selected.target.owner === 'PUBLIC' ||
        selected.editionName ||
        selected.sharing !== 'NONE' ||
        selected.unsupportedFeatures.length
      )
        return { aliases, error: 'UNSUPPORTED_SYNONYM' };
      reference = selected.target;
      type = selected.targetType;
    } else {
      const facts = document.prerequisites.filter(
        (item) => item.type === 'SYNONYM' && objectKey(item.reference) === key,
      );
      const resolution = facts[0]?.synonymResolution;
      if (
        !resolution ||
        facts.some(
          (fact) =>
            JSON.stringify(fact.synonymResolution) !==
            JSON.stringify(resolution),
        )
      )
        return { aliases, error: 'MISSING_SYNONYM_TARGET' };
      let expected = reference;
      for (const [index, link] of resolution.links.entries()) {
        if (
          objectKey(link.reference) !== objectKey(expected) ||
          (index > 0 && seen.has(objectKey(link.reference)))
        )
          return { aliases, error: 'SYNONYM_DEPENDENCY_CYCLE' };
        if (
          link.databaseLink ||
          link.reference.owner === 'PUBLIC' ||
          link.target.owner === 'PUBLIC'
        )
          return { aliases, error: 'UNSUPPORTED_SYNONYM' };
        const acknowledged = providers.get(objectKey(link.reference));
        if (!acknowledged || acknowledged.type !== 'SYNONYM')
          return { aliases, error: 'MISSING_SYNONYM_TARGET' };
        const definition = document.synonyms.find(
          (item) => objectKey(item.reference) === objectKey(link.reference),
        );
        if (
          definition &&
          (objectKey(definition.target) !== objectKey(link.target) ||
            definition.databaseLink !== link.databaseLink ||
            definition.targetType !==
              (index === resolution.links.length - 1
                ? resolution.terminal.type
                : 'SYNONYM'))
        )
          return { aliases, error: 'UNSUPPORTED_SYNONYM' };
        if (index > 0) {
          seen.add(objectKey(link.reference));
          aliases.push(link.reference);
        }
        expected = link.target;
      }
      if (
        objectKey(expected) !== objectKey(resolution.terminal.reference) ||
        resolution.terminal.type === 'SYNONYM'
      )
        return { aliases, error: 'MISSING_SYNONYM_TARGET' };
      reference = resolution.terminal.reference;
      type = resolution.terminal.type;
    }
  }
}

export function validateProviders(document: TargetDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, reference: ObjectReference, message: string) =>
    diagnostics.push({
      severity: 'error' as const,
      code,
      object: qualifiedName(reference),
      message,
    });
  const names = new Set<string>();
  const externalTypes = new Map<string, string>();
  for (const prerequisite of document.policy.externalPrerequisites) {
    const key = objectKey(prerequisite.reference);
    if (externalTypes.has(key) && externalTypes.get(key) !== prerequisite.type)
      error(
        'OBJECT_NAME_COLLISION',
        prerequisite.reference,
        'External prerequisite has contradictory object types.',
      );
    externalTypes.set(key, prerequisite.type);
  }
  for (const item of [
    ...document.tables,
    ...document.views,
    ...document.sequences,
    ...document.synonyms,
    ...document.programUnits.filter((unit) => unit.type !== 'PACKAGE BODY'),
  ]) {
    if (names.has(objectKey(item.reference)))
      error(
        'OBJECT_NAME_COLLISION',
        item.reference,
        'Included objects share a schema namespace.',
      );
    names.add(objectKey(item.reference));
  }
  for (const [roots, definitions] of [
    [document.targetSequences, document.sequences],
    [document.targetSynonyms, document.synonyms],
  ] as const) {
    const keys = new Set(roots.map(objectKey));
    if (keys.size !== roots.length)
      diagnostics.push({
        severity: 'error',
        code: 'OBJECT_SELECTION_MISMATCH',
        object: 'document',
        message: 'Duplicate explicit object roots.',
      });
    for (const root of roots)
      if (
        definitions.filter(
          (item) => objectKey(item.reference) === objectKey(root),
        ).length !== 1
      )
        error(
          'OBJECT_SELECTION_MISMATCH',
          root,
          'Selected definition is missing or duplicated.',
        );
    for (const item of definitions)
      if (!keys.has(objectKey(item.reference)))
        error(
          'OBJECT_SELECTION_MISMATCH',
          item.reference,
          'Definition was not explicitly selected.',
        );
  }
  const check = (
    reference: ObjectReference,
    edge: ViewDependency,
    program = false,
  ) => {
    if (
      ![
        'TABLE',
        'VIEW',
        'PROCEDURE',
        'FUNCTION',
        'PACKAGE',
        'SEQUENCE',
        'SYNONYM',
        'TYPE',
      ].includes(edge.type)
    ) {
      error(
        'UNSUPPORTED_PROGRAM_DEPENDENCY',
        reference,
        'Unsupported dependency kind.',
      );
      return;
    }
    const resolution = resolveProvider(document, edge);
    if (resolution.error)
      error(
        program &&
          ['TABLE', 'VIEW'].includes(edge.type) &&
          resolution.error === 'UNACKNOWLEDGED_PREREQUISITE'
          ? 'MISSING_PROGRAM_DEPENDENCY'
          : resolution.error,
        reference,
        `Select or acknowledge required ${edge.type} ${qualifiedName(edge.reference)}.`,
      );
  };
  for (const synonym of document.synonyms)
    check(synonym.reference, {
      reference: synonym.reference,
      type: 'SYNONYM',
      databaseLink: null,
    });
  for (const unit of document.programUnits)
    for (const edge of unit.dependencies)
      if (!edge.oracleMaintained || edge.databaseLink)
        check(unit.reference, edge, true);
  for (const table of document.tables)
    for (const edge of table.dependencies) check(table.reference, edge);
  for (const prerequisite of document.prerequisites) {
    if (
      (prerequisite.type === 'SYNONYM') !==
      (prerequisite.synonymResolution !== null)
    )
      error(
        'UNSUPPORTED_SYNONYM',
        prerequisite.reference,
        'Synonym prerequisites require resolution facts; other prerequisite types require null.',
      );
    if (prerequisite.synonymResolution) {
      const resolution = prerequisite.synonymResolution;
      let expected = prerequisite.reference;
      const seen = new Set<string>();
      for (const [index, link] of resolution.links.entries()) {
        const key = objectKey(link.reference);
        if (seen.has(key) || key !== objectKey(expected))
          error(
            'SYNONYM_DEPENDENCY_CYCLE',
            prerequisite.reference,
            'Resolution links repeat or do not form the captured chain.',
          );
        seen.add(key);
        expected = link.target;
        if (
          link.databaseLink ||
          link.reference.owner === 'PUBLIC' ||
          link.target.owner === 'PUBLIC'
        )
          error(
            'UNSUPPORTED_SYNONYM',
            prerequisite.reference,
            'Remote or public resolution is unsupported.',
          );
        const provider = providerIndex(document).get(key);
        if (!provider || provider.type !== 'SYNONYM')
          error(
            'MISSING_SYNONYM_TARGET',
            link.reference,
            'Every chain link must be selected or acknowledged.',
          );
        const selected = document.synonyms.find(
          (item) => objectKey(item.reference) === key,
        );
        if (
          selected &&
          (objectKey(selected.target) !== objectKey(link.target) ||
            selected.databaseLink !== link.databaseLink ||
            selected.targetType !==
              (index === resolution.links.length - 1
                ? resolution.terminal.type
                : 'SYNONYM'))
        )
          error(
            'UNSUPPORTED_SYNONYM',
            link.reference,
            'Selected mapping disagrees with captured resolution.',
          );
      }
      if (
        objectKey(expected) !== objectKey(resolution.terminal.reference) ||
        resolution.terminal.type === 'SYNONYM' ||
        seen.has(objectKey(expected))
      )
        error(
          'SYNONYM_DEPENDENCY_CYCLE',
          prerequisite.reference,
          'Resolution must end in the recorded non-alias terminal.',
        );
      check(prerequisite.requiredBy, {
        ...resolution.terminal,
        databaseLink: null,
      });
    }
    check(prerequisite.requiredBy, prerequisite);
  }
  return diagnostics;
}
