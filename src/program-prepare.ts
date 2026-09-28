import { orderedProgramUnits } from './program-units.js';
/** Operation graph for mixed table/view/program reconstruction. */
import {
  objectKey,
  qualifiedName,
  type ObjectReference,
  type TargetDocument,
  type ViewDependency,
} from './model.js';
import {
  renderTable,
  renderIndex,
  renderLocalConstraint,
  renderForeignKey,
  renderView,
} from './ddl.js';
import { renderComment } from './comments.js';
import { indexRequirements } from './index-grants.js';
import {
  programRequirements,
  renderProgramGrant,
  type ProgramGrant,
} from './program-grants.js';
import { renderProgramDdl } from './plsql-ddl.js';
import type { SqlCollector } from './sql-preparation.js';

interface Operation {
  key: string;
  object: string;
  dependencies: Set<string>;
  render: () => string[];
}
const nodeKey = (type: string, reference: ObjectReference) =>
  JSON.stringify([reference.owner, reference.name, type]);

export function prepareProgramOperations(
  document: TargetDocument,
  collector: SqlCollector,
): void {
  const operations = new Map<string, Operation>();
  const programs = new Map(
    document.programs.map((program) => [objectKey(program.reference), program]),
  );
  const tables = new Map(
    document.tables.map((table) => [objectKey(table.reference), table]),
  );
  const views = new Map(
    document.views.map((view) => [objectKey(view.reference), view]),
  );
  const included = (edge: ViewDependency) =>
    edge.type === 'TABLE'
      ? tables.has(objectKey(edge.reference))
      : edge.type === 'VIEW'
        ? views.has(objectKey(edge.reference))
        : programs.get(objectKey(edge.reference))?.kind.toUpperCase() ===
          edge.type;
  const add = (
    type: string,
    reference: ObjectReference,
    dependencies: string[],
    render: () => string[],
  ) => {
    const key = nodeKey(type, reference);
    operations.set(key, {
      key,
      object: qualifiedName(reference),
      dependencies: new Set(dependencies),
      render,
    });
    return key;
  };
  const executable = (
    reference: ObjectReference,
    seen = new Set<string>(),
  ): string[] => {
    const key = objectKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    const program = programs.get(key);
    if (!program) {
      const view = views.get(key);
      if (view)
        return [
          nodeKey('VIEW', reference),
          ...view.dependencies
            .filter((edge) => !edge.databaseLink && !edge.oracleMaintained)
            .flatMap((edge) => executable(edge.reference, seen)),
        ];
      if (tables.has(key))
        return [
          nodeKey('TABLE', reference),
          ...document.prerequisites
            .filter(
              (edge) =>
                objectKey(edge.requiredBy) === key &&
                edge.origin !== 'INDEX' &&
                !edge.databaseLink &&
                !edge.oracleMaintained,
            )
            .flatMap((edge) => executable(edge.reference, seen)),
        ];
      return [];
    }
    return [
      ...program.units.map((unit) => nodeKey(unit.type, reference)),
      ...program.units.flatMap((unit) =>
        unit.dependencies
          .filter((edge) => !edge.databaseLink && !edge.oracleMaintained)
          .flatMap((edge) => executable(edge.reference, seen)),
      ),
    ];
  };
  const grant = (value: ProgramGrant): string => {
    const type = tables.has(objectKey(value.reference))
      ? 'TABLE'
      : views.has(objectKey(value.reference))
        ? 'VIEW'
        : programs.get(objectKey(value.reference))?.kind.toUpperCase();
    const key = nodeKey(
      `GRANT:${value.grantee}:${value.privilege}`,
      value.reference,
    );
    if (!operations.has(key))
      add(
        `GRANT:${value.grantee}:${value.privilege}`,
        value.reference,
        type ? [nodeKey(type, value.reference)] : [],
        () => [renderProgramGrant(value)],
      );
    return key;
  };
  const dependencies = (
    edges: (ViewDependency & { oracleMaintained?: boolean })[],
    owner: string,
    execution: boolean,
  ): string[] =>
    edges.flatMap((edge) => {
      if (edge.databaseLink || edge.oracleMaintained || !included(edge))
        return [];
      const result = [nodeKey(edge.type, edge.reference)];
      // ALTER TABLE constraints can invalidate an already compiled view/program.
      // A table dependency therefore waits for its constraint DDL as well.
      if (edge.type === 'TABLE') {
        result.push(
          ...(tables.get(objectKey(edge.reference))?.constraints ?? [])
            .filter((constraint) => constraint.kind !== 'not-null')
            .map((constraint) =>
              nodeKey('CONSTRAINT', {
                owner: edge.reference.owner,
                name: constraint.name,
              }),
            ),
        );
      }
      if (execution && programs.has(objectKey(edge.reference)))
        result.push(...executable(edge.reference));
      if (
        edge.reference.owner !== owner &&
        programs.has(objectKey(edge.reference))
      )
        result.push(
          grant({
            reference: edge.reference,
            grantee: owner,
            privilege: 'EXECUTE',
          }),
        );
      return result;
    });
  const programGrants = programRequirements(document).grants;
  for (const value of [...programGrants, ...indexRequirements(document).grants])
    grant(value);
  for (const table of document.tables) {
    const tableNode = nodeKey('TABLE', table.reference);
    const requirements = document.prerequisites.filter(
      (item) => objectKey(item.requiredBy) === objectKey(table.reference),
    );
    // Keep catalog origin: the same function can be required by both a table
    // expression and an index. Subtracting index identities loses table edges.
    const tableEdges = requirements.filter((edge) => edge.origin !== 'INDEX');
    add(
      'TABLE',
      table.reference,
      dependencies(tableEdges, table.reference.owner, true),
      () => {
        const output = [
          renderTable(
            table,
            [...table.columns].sort((a, b) => a.position - b.position),
            document.policy,
            collector.attemptRender,
          ),
        ];
        if (table.comment !== null)
          output.push(
            collector.attemptRender(
              'UNRENDERABLE_TABLE_COMMENT',
              qualifiedName(table.reference),
              () => renderComment(table.reference, null, table.comment!),
            ),
          );
        for (const column of [...table.columns].sort(
          (a, b) => a.position - b.position,
        ))
          if (column.comment !== null)
            output.push(
              collector.attemptRender(
                'UNRENDERABLE_COLUMN_COMMENT',
                qualifiedName(table.reference),
                () =>
                  renderComment(table.reference, column.name, column.comment!),
              ),
            );
        return output;
      },
    );
    for (const index of table.indexes) {
      add(
        'INDEX',
        index.reference,
        [
          tableNode,
          ...dependencies(index.dependencies, index.reference.owner, true),
        ],
        () => [renderIndex(table.reference, index, collector.attemptRender)],
      );
    }
    for (const constraint of table.constraints) {
      if (constraint.kind === 'not-null') continue;
      const deps = [tableNode];
      if (constraint.kind === 'foreign-key') {
        deps.push(
          nodeKey('TABLE', constraint.parentTable),
          nodeKey('CONSTRAINT', constraint.parentConstraint),
        );
        if (constraint.parentTable.owner !== table.reference.owner)
          deps.push(
            grant({
              reference: constraint.parentTable,
              grantee: table.reference.owner,
              privilege: 'REFERENCES',
            }),
          );
      } else if (
        (constraint.kind === 'primary-key' || constraint.kind === 'unique') &&
        constraint.backingIndex
      )
        deps.push(nodeKey('INDEX', constraint.backingIndex));
      add(
        'CONSTRAINT',
        { owner: table.reference.owner, name: constraint.name },
        deps,
        () => [
          constraint.kind === 'foreign-key'
            ? renderForeignKey(table.reference, constraint)
            : renderLocalConstraint(table.reference, constraint),
        ],
      );
    }
  }
  for (const view of document.views) {
    const deps = dependencies(view.dependencies, view.reference.owner, false);
    for (const edge of view.dependencies)
      if (
        !edge.databaseLink &&
        !edge.oracleMaintained &&
        ['TABLE', 'VIEW'].includes(edge.type) &&
        edge.reference.owner !== view.reference.owner
      )
        deps.push(
          grant({
            reference: edge.reference,
            grantee: view.reference.owner,
            privilege: 'SELECT',
          }),
        );
    add('VIEW', view.reference, deps, () => [renderView(view)]);
  }
  const orderedUnits = orderedProgramUnits(document);
  for (const [operationIndex, { program, unit }] of orderedUnits.entries()) {
    const own = nodeKey(unit.type, program.reference);
    const deps = dependencies(
      unit.dependencies,
      program.reference.owner,
      false,
    ).filter((key) => key !== own);
    if (unit.type === 'PACKAGE BODY')
      deps.push(nodeKey('PACKAGE', program.reference));
    for (const value of programGrants)
      if (
        value.grantee === program.reference.owner &&
        unit.dependencies.some(
          (edge) => objectKey(edge.reference) === objectKey(value.reference),
        )
      )
        deps.push(grant(value));
    add(unit.type, program.reference, deps, () => [
      collector.attemptRender(
        'UNSUPPORTED_PLSQL',
        qualifiedName(program.reference),
        () =>
          renderProgramDdl({
            reference: program.reference,
            type: unit.type,
            source: unit.sourceLines.map((line) => line.text).join(''),
            editionable: program.editionable,
            operationIndex,
            settings: unit.settings,
          }),
      ),
    ]);
  }
  const remaining = new Map(operations);
  const completed = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((operation) =>
        [...operation.dependencies].every((key) => completed.has(key)),
      )
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    if (!ready.length) {
      collector.result.diagnostics.push({
        severity: 'error',
        code: 'PLSQL_DEPENDENCY_CYCLE',
        object: 'document',
        message: `Unresolvable compilation operations: ${[...remaining.values()]
          .map((operation) => operation.key)
          .sort()
          .join(', ')}`,
      });
      break;
    }
    for (const operation of ready) {
      collector.emit(operation.object, ...operation.render());
      completed.add(operation.key);
      remaining.delete(operation.key);
    }
  }
}
