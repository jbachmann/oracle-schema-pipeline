import {
  objectKey,
  qualifiedName,
  type Diagnostic,
  type ProgramUnit,
  type TargetDocument,
} from './model.js';

export interface ProgramToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

/** Small lossless lexer: offsets are used only to bind the declaration header. */
export function programTokens(source: string): ProgramToken[] {
  const tokens: ProgramToken[] = [];
  let i = 0;
  const fail = () => {
    throw new Error('Malformed program lexical structure.');
  };
  while (i < source.length) {
    if (/\s/u.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith('--', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) fail();
      i = end + 2;
      continue;
    }
    const start = i;
    if ((source[i] === 'q' || source[i] === 'Q') && source[i + 1] === "'") {
      const opener = source[i + 2];
      const closer =
        ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[
          opener
        ] ?? opener;
      const end = source.indexOf(closer + "'", i + 3);
      if (end < 0) fail();
      i = end + 2;
      tokens.push({ value: '<literal>', start, end: i, quoted: true });
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const delimiter = source[i++];
      let value = '';
      let closed = false;
      while (i < source.length) {
        if (source[i] === delimiter) {
          if (source[i + 1] === delimiter) {
            value += delimiter;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else value += source[i++];
      }
      if (!closed) fail();
      tokens.push({
        value: delimiter === '"' ? value : '<literal>',
        start,
        end: i,
        quoted: true,
      });
      continue;
    }
    const word = /^[\p{L}_$#][\p{L}\p{N}_$#]*/u.exec(source.slice(i));
    if (word) {
      i += word[0].length;
      tokens.push({
        value: word[0].toUpperCase(),
        start,
        end: i,
        quoted: false,
      });
    } else {
      i++;
      tokens.push({ value: source[start], start, end: i, quoted: false });
    }
  }
  return tokens;
}

export function programDeclaration(unit: ProgramUnit): {
  statement: string;
  tokens: ProgramToken[];
} {
  const source = unit.sourceLines.map((line) => line.text).join('');
  if (unit.sourceLines.some((line, i) => line.line !== i + 1))
    throw new Error('Program source lines must be contiguous from one.');
  const tokens = programTokens(source);
  const kind = unit.type.split(' ');
  if (kind.some((word, i) => tokens[i]?.quoted || tokens[i]?.value !== word))
    throw new Error(
      'Program declaration kind does not match catalog identity.',
    );
  let name = tokens[kind.length];
  const first = name;
  if (!name) throw new Error('Program declaration name is absent.');
  if (tokens[kind.length + 1]?.value === '.') {
    if (name.value !== unit.reference.owner)
      throw new Error(
        'Program declaration owner does not match catalog identity.',
      );
    name = tokens[kind.length + 2];
  }
  if (!name || name.value !== unit.reference.name)
    throw new Error(
      'Program declaration name does not match catalog identity.',
    );
  const next = tokens.find((token) => token.start >= name.end);
  if (
    !next ||
    ![
      '(',
      'AS',
      'IS',
      'RETURN',
      'AUTHID',
      'ACCESSIBLE',
      'DEFAULT',
      'DETERMINISTIC',
      'RESULT_CACHE',
      'WRAPPED',
    ].includes(next.value)
  )
    throw new Error('Unsupported program declaration header.');
  return {
    statement:
      `CREATE ${unit.editionable ? 'EDITIONABLE' : 'NONEDITIONABLE'} ` +
      source.slice(0, first.start) +
      qualifiedName(unit.reference) +
      source.slice(name.end),
    tokens,
  };
}

export function validatePrograms(document: TargetDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, unit: ProgramUnit, message: string) =>
    diagnostics.push({
      severity: 'error' as const,
      code,
      object: `${qualifiedName(unit.reference)} ${unit.type}`,
      message,
    });
  const byKey = new Map(
    document.programUnits.map((unit) => [
      JSON.stringify([objectKey(unit.reference), unit.type]),
      unit,
    ]),
  );
  const authorized = new Set<string>();
  const packageKeys = new Set(document.targetPackages.map(objectKey));
  for (const [roots, type] of [
    [document.targetProcedures, 'PROCEDURE'],
    [document.targetFunctions, 'FUNCTION'],
  ] as const) {
    for (const root of roots) {
      const reference =
        'package' in root ? { owner: root.owner, name: root.package } : root;
      const unit = byKey.get(
        JSON.stringify([
          objectKey(reference),
          'package' in root ? 'PACKAGE' : type,
        ]),
      );
      if ('package' in root) packageKeys.add(objectKey(reference));
      else authorized.add(JSON.stringify([objectKey(reference), type]));
      if (
        !unit ||
        ('package' in root &&
          (!unit.packageBodyPresent ||
            !unit.members.some(
              (member) =>
                member.name === root.name && member.kind === type.toLowerCase(),
            )))
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'PROGRAM_SELECTION_MISMATCH',
          object: qualifiedName(reference),
          message: 'Selected routine kind or implementation is absent.',
        });
      }
    }
  }
  for (const key of packageKeys) {
    const spec = byKey.get(JSON.stringify([key, 'PACKAGE']));
    authorized.add(JSON.stringify([key, 'PACKAGE']));
    if (!spec)
      diagnostics.push({
        severity: 'error',
        code: 'PROGRAM_SELECTION_MISMATCH',
        object: key,
        message: 'Selected package specification is absent.',
      });
    if (spec?.packageBodyPresent)
      authorized.add(JSON.stringify([key, 'PACKAGE BODY']));
    if (
      Boolean(spec?.packageBodyPresent) !==
      byKey.has(JSON.stringify([key, 'PACKAGE BODY']))
    ) {
      if (spec)
        error(
          'PROGRAM_SELECTION_MISMATCH',
          spec,
          'Package body presence disagrees with included units.',
        );
    }
  }
  const seen = new Set<string>();
  for (const unit of document.programUnits) {
    const key = JSON.stringify([objectKey(unit.reference), unit.type]);
    if (seen.has(key) || !authorized.has(key))
      error(
        'PROGRAM_SELECTION_MISMATCH',
        unit,
        'Duplicate or unselected compilation unit.',
      );
    seen.add(key);
    if (unit.status !== 'VALID')
      error('INVALID_PROGRAM', unit, 'Invalid source program.');
    if (unit.editionName !== null || unit.unsupportedFeatures.length)
      error(
        'UNSUPPORTED_PROGRAM',
        unit,
        'Unsupported catalog program features.',
      );
    if (
      (unit.type === 'PACKAGE') !== (unit.packageBodyPresent !== null) ||
      (unit.type === 'PACKAGE BODY') !== (unit.authid === null) ||
      ['PROCEDURE', 'FUNCTION'].includes(unit.type) !==
        (unit.routineProperties !== null) ||
      (unit.type !== 'PACKAGE' && unit.members.length)
    )
      error('INVALID_PROGRAM', unit, 'Inconsistent compilation-unit metadata.');
    if (
      new Set(unit.members.map((member) => member.subprogramId)).size !==
      unit.members.length
    )
      error('INVALID_PROGRAM', unit, 'Duplicate public subprogram identity.');
    for (const properties of [
      unit.routineProperties,
      ...unit.members.map((member) => member.routineProperties),
    ]) {
      if (
        properties &&
        (properties.pipelined ||
          properties.parallelEnabled ||
          properties.aggregate ||
          properties.sqlMacro !== 'NONE')
      )
        error(
          'UNSUPPORTED_FUNCTION',
          unit,
          'Specialized routine form is unsupported.',
        );
    }
    if (unit.compilerSettings.plsqlImplicitConversionBool === null)
      error(
        'UNSUPPORTED_PROGRAM_SETTINGS',
        unit,
        'Boolean conversion semantics are unavailable; this source version needs verification.',
      );
    try {
      const { tokens } = programDeclaration(unit);
      const words = tokens
        .filter((token) => !token.quoted)
        .map((token) => token.value);
      if (
        words.some((word) =>
          [
            'WRAPPED',
            'EXTERNAL',
            'PIPELINED',
            'PARALLEL_ENABLE',
            'SQL_MACRO',
            'AGGREGATE',
            'SHARD_ENABLE',
            'MLE',
          ].includes(word),
        ) ||
        words.some(
          (word, i) =>
            word === 'LANGUAGE' &&
            ['JAVA', 'C', 'JAVASCRIPT'].includes(words[i + 1]),
        )
      )
        error('UNSUPPORTED_PROGRAM', unit, 'Unsupported stored program form.');
      if (
        unit.type === 'PACKAGE' &&
        !unit.packageBodyPresent &&
        (unit.members.length ||
          words.some((word) =>
            ['PROCEDURE', 'FUNCTION', 'CURSOR', '$IF', '$'].includes(word),
          ))
      )
        error(
          'PROGRAM_SELECTION_MISMATCH',
          unit,
          'Body-less package has declarations requiring implementation or ambiguous conditional declarations.',
        );
      if (unit.type === 'PACKAGE')
        for (const member of unit.members) {
          const declarations = tokens.flatMap((token, index) => {
            if (
              token.quoted ||
              token.value !== member.kind.toUpperCase() ||
              tokens[index + 1]?.value !== member.name
            )
              return [];
            const end = tokens.findIndex(
              (next, position) =>
                position > index && !next.quoted && next.value === ';',
            );
            return [
              tokens
                .slice(index, end < 0 ? tokens.length : end)
                .filter((next) => !next.quoted)
                .map((next) => next.value),
            ];
          });
          if (
            !declarations.some(
              (declaration) =>
                declaration.includes('DETERMINISTIC') ===
                  member.routineProperties.deterministic &&
                declaration.includes('RESULT_CACHE') ===
                  member.routineProperties.resultCache,
            )
          )
            error(
              'INVALID_PROGRAM',
              unit,
              'Public member identity or properties disagree with the specification.',
            );
        }
      if (unit.type !== 'PACKAGE BODY') {
        const header = words.slice(
          0,
          words.findIndex((word) => word === 'IS' || word === 'AS'),
        );
        const authid = header.includes('AUTHID')
          ? header[header.indexOf('AUTHID') + 1]
          : 'DEFINER';
        if (authid !== unit.authid)
          error(
            'INVALID_PROGRAM',
            unit,
            'AUTHID disagrees with the declaration.',
          );
      }
      if (unit.routineProperties && unit.type === 'FUNCTION') {
        const header = words.slice(
          0,
          words.findIndex((word) => word === 'IS' || word === 'AS'),
        );
        if (
          header.includes('DETERMINISTIC') !==
            unit.routineProperties.deterministic ||
          header.includes('RESULT_CACHE') !== unit.routineProperties.resultCache
        )
          error(
            'INVALID_PROGRAM',
            unit,
            'Function properties disagree with the declaration.',
          );
      }
    } catch {
      error(
        'PROGRAM_SOURCE_IDENTITY',
        unit,
        'Program source or declaration does not match its modeled identity.',
      );
    }
  }
  return diagnostics;
}
