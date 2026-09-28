import { programSessionSettings } from './program-settings.js';
/** Independent analysis of program facts and their captured dependency closure. */
import {
  objectKey,
  qualifiedName,
  type TargetDocument,
  type Diagnostic,
  type ViewDependency,
  type ProgramDefinition,
} from './model.js';
import {
  inspectPlsqlSource,
  PlsqlSourceError,
  packageDeclarationEvidence,
  declarationAuthid,
} from './plsql.js';

export function analyzePrograms(document: TargetDocument) {
  const diagnostics: Diagnostic[] = [];
  const error = (
    code: string,
    reference: { owner: string; name: string },
    message: string,
  ) =>
    diagnostics.push({
      severity: 'error',
      code,
      object: qualifiedName(reference),
      message,
    });
  const programs = new Map(
    document.programs.map((program) => [objectKey(program.reference), program]),
  );
  const tables = new Map(
    document.tables.map((table) => [objectKey(table.reference), table]),
  );
  const views = new Map(
    document.views.map((view) => [objectKey(view.reference), view]),
  );
  const programRoots = [
    ...document.targetPackages,
    ...document.targetProcedures.map((root) => ({
      owner: root.owner,
      name: root.package ?? root.name,
    })),
  ];
  const roots = new Set(programRoots.map(objectKey));
  const reachablePrograms = new Set<string>();
  const reachableTables = new Set<string>();
  const reachableViews = new Set<string>();
  if (document.selectionVersion === 2 && (programRoots.length || programs.size))
    diagnostics.push({
      severity: 'error',
      code: 'ROLE_MISMATCH',
      object: 'document',
      message: 'Selection v2 cannot contain program roots or definitions.',
    });
  if (programs.size !== document.programs.length)
    diagnostics.push({
      severity: 'error',
      code: 'DUPLICATE_PROGRAM',
      object: 'document',
      message: 'Program identities must be unique.',
    });
  const pending: ViewDependency[] = [
    ...document.targetPackages.map((reference) => ({
      reference,
      type: 'PACKAGE',
      databaseLink: null,
    })),
    ...document.targetProcedures.map((root) => ({
      reference: { owner: root.owner, name: root.package ?? root.name },
      type: root.package === undefined ? 'PROCEDURE' : 'PACKAGE',
      databaseLink: null,
    })),
  ];
  const follow = (
    edges: (ViewDependency & { oracleMaintained?: boolean })[],
  ) => {
    pending.push(
      ...edges.filter((edge) => !edge.databaseLink && !edge.oracleMaintained),
    );
  };
  while (pending.length) {
    const edge = pending.shift()!;
    const key = objectKey(edge.reference);
    if (edge.type === 'TABLE' || edge.type === 'VIEW') {
      const map = edge.type === 'TABLE' ? tables : views;
      const reachable =
        edge.type === 'TABLE' ? reachableTables : reachableViews;
      if (!map.has(key)) {
        error(
          'MISSING_PLSQL_DEPENDENCY',
          edge.reference,
          'Required supported dependency is absent.',
        );
        continue;
      }
      if (reachable.has(key)) continue;
      reachable.add(key);
      if (edge.type === 'TABLE')
        follow([
          ...document.prerequisites.filter(
            (item) => objectKey(item.requiredBy) === key,
          ),
          ...tables.get(key)!.indexes.flatMap((index) => index.dependencies),
        ]);
      else follow(views.get(key)!.dependencies);
    } else if (['PROCEDURE', 'FUNCTION', 'PACKAGE'].includes(edge.type)) {
      const program = programs.get(key);
      if (!program) {
        error(
          'MISSING_PLSQL_DEPENDENCY',
          edge.reference,
          'Required program is absent.',
        );
        continue;
      }
      if (program.kind.toUpperCase() !== edge.type)
        error(
          'PLSQL_SOURCE_MISMATCH',
          edge.reference,
          'Dependency type disagrees with included definition.',
        );
      if (reachablePrograms.has(key)) continue;
      reachablePrograms.add(key);
      follow(program.units.flatMap((unit) => unit.dependencies));
    }
  }
  for (const reference of programRoots)
    if (!programs.has(objectKey(reference)))
      error('MISSING_TARGET', reference, 'Requested program is absent.');
  for (const request of document.targetProcedures) {
    if (!request.package) continue;
    const reference = { owner: request.owner, name: request.package };
    const program = programs.get(objectKey(reference));
    if (
      program?.kind !== 'package' ||
      !program.publicProcedures.some((member) => member.name === request.name)
    )
      error(
        'PLSQL_MEMBER_NOT_FOUND',
        reference,
        'Requested public procedure is absent.',
      );
  }
  for (const program of document.programs) {
    const key = objectKey(program.reference);
    if (!reachablePrograms.has(key))
      error(
        'EXTRA_PROGRAM',
        program.reference,
        'Program is outside the requested closure.',
      );
    if (
      program.role !== (roots.has(key) ? 'target' : 'dependency') ||
      (program.kind === 'function' && program.role !== 'dependency')
    )
      error(
        'ROLE_MISMATCH',
        program.reference,
        'Program role disagrees with roots.',
      );
    if (tables.has(key) || views.has(key))
      error(
        'OBJECT_NAME_COLLISION',
        program.reference,
        'Programs, tables and views share a namespace.',
      );
    if (
      program.oracleMaintained ||
      program.sourceOwnerEditionsEnabled ||
      program.unsupportedFeatures.length
    )
      error(
        'UNSUPPORTED_PLSQL',
        program.reference,
        'Unsupported platform, edition or source semantics.',
      );
    const expected =
      program.kind === 'package'
        ? [
            'PACKAGE',
            ...(program.bodyRequired ||
            program.units.some((unit) => unit.type === 'PACKAGE BODY')
              ? ['PACKAGE BODY']
              : []),
          ]
        : [program.kind.toUpperCase()];
    if (
      expected.length !== program.units.length ||
      expected.some(
        (type) =>
          program.units.filter((unit) => unit.type === type).length !== 1,
      )
    )
      error(
        'PLSQL_SOURCE_MISMATCH',
        program.reference,
        'Program units are incomplete or duplicated.',
      );
    for (const unit of program.units) {
      try {
        programSessionSettings(unit.settings);
      } catch {
        error(
          'UNSUPPORTED_PLSQL',
          program.reference,
          'Unsupported compiler settings.',
        );
      }

      if (unit.status !== 'VALID')
        error('INVALID_PLSQL', program.reference, 'Source unit is invalid.');
      if (unit.sourceLines.some((line, index) => line.line !== index + 1))
        error(
          'PLSQL_SOURCE_MISMATCH',
          program.reference,
          'Source lines must be contiguous from one.',
        );
      const source = unit.sourceLines.map((line) => line.text).join('');
      try {
        inspectPlsqlSource(source, program.reference, unit.type);
        if (
          unit.type !== 'PACKAGE BODY' &&
          declarationAuthid(source, program.reference, unit.type) !==
            program.authid
        )
          error(
            'PLSQL_SOURCE_MISMATCH',
            program.reference,
            'AUTHID disagrees with declaration.',
          );
      } catch (reason) {
        error(
          reason instanceof PlsqlSourceError
            ? reason.code
            : 'PLSQL_SOURCE_MISMATCH',
          program.reference,
          'Source declaration is unsupported or inconsistent.',
        );
      }
      for (const edge of unit.dependencies) {
        if (edge.databaseLink)
          error(
            'REMOTE_PREREQUISITE',
            program.reference,
            'Remote program dependencies are unsupported.',
          );
        else if (
          !edge.oracleMaintained &&
          !['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE'].includes(
            edge.type,
          ) &&
          !document.policy.externalPrerequisites.some(
            (item) =>
              objectKey(item.reference) === objectKey(edge.reference) &&
              item.type === edge.type,
          )
        )
          error(
            'UNACKNOWLEDGED_PREREQUISITE',
            edge.reference,
            'External program prerequisite requires provisioning and acknowledgement.',
          );
      }
    }
    validatePackageEvidence(program, error);
  }
  for (const item of document.policy.externalPrerequisites)
    if (
      programs.has(objectKey(item.reference)) ||
      tables.has(objectKey(item.reference)) ||
      views.has(objectKey(item.reference))
    )
      error(
        'INTERNAL_PREREQUISITE_CONFLICT',
        item.reference,
        'Included definitions cannot also be external prerequisites.',
      );
  if (programs.size)
    diagnostics.push({
      severity: 'warning',
      code: 'PLSQL_RUNTIME_DEPENDENCIES',
      object: 'document',
      message:
        'Recorded catalog edges do not exhaust dynamic SQL or invoker-specific runtime dependencies.',
    });
  return {
    diagnostics,
    programs,
    reachablePrograms,
    reachableTables,
    reachableViews,
  };
}

function validatePackageEvidence(
  program: ProgramDefinition,
  error: (
    code: string,
    reference: { owner: string; name: string },
    message: string,
  ) => void,
): void {
  if (program.kind !== 'package') return;
  const specification = program.units.find((unit) => unit.type === 'PACKAGE');
  if (!specification) return;
  const source = specification.sourceLines.map((line) => line.text).join('');
  try {
    const { procedures, bodyRequired: needsBody } = packageDeclarationEvidence(
      source,
      program.reference,
    );
    if (
      new Set(
        program.publicProcedures.map((member) =>
          JSON.stringify([member.name, member.overload]),
        ),
      ).size !== program.publicProcedures.length
    )
      error(
        'PLSQL_SOURCE_MISMATCH',
        program.reference,
        'Public procedure identities are duplicated.',
      );
    if (needsBody && !program.bodyRequired)
      error(
        'PLSQL_SOURCE_MISMATCH',
        program.reference,
        'Package body requirement contradicts declarations.',
      );
    const declared = [...procedures].sort();
    const captured = program.publicProcedures
      .map((member) => member.name)
      .sort();
    if (JSON.stringify(declared) !== JSON.stringify(captured))
      error(
        'PLSQL_SOURCE_MISMATCH',
        program.reference,
        'Public procedure metadata contradicts specification.',
      );
  } catch {
    /* Main source check reports the safe diagnostic. */
  }
}
