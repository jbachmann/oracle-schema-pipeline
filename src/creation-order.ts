import {
  objectKey,
  type TargetDocument,
  type TableDefinition,
  type ViewDefinition,
  type ProgramDefinition,
} from './model.js';
import { isIncluded, resolveDependency } from './dependencies.js';
export type Creation =
  | { kind: 'table'; value: TableDefinition }
  | { kind: 'view'; value: ViewDefinition }
  | { kind: 'program'; value: ProgramDefinition };

/** Collapse strongly connected program groups; reject cycles involving SQL consumers. */
export function creationOrder(document: TargetDocument): Creation[][] {
  const nodes = new Map<string, Creation>([
    ...document.tables.map(
      (value) =>
        [objectKey(value.reference), { kind: 'table', value }] as const,
    ),
    ...document.views.map(
      (value) => [objectKey(value.reference), { kind: 'view', value }] as const,
    ),
    ...document.programs.flatMap((program) =>
      program.units.map((unit): [string, Creation] => [
        `${objectKey(program.reference)}:${unit.type}`,
        { kind: 'program', value: { ...program, units: [unit] } },
      ]),
    ),
  ]);
  const edges = new Map<string, string[]>();
  for (const [key, node] of nodes) {
    const dependencies =
      node.kind === 'table'
        ? document.prerequisites.filter(
            (p) => objectKey(p.requiredBy) === key && p.origin !== 'INDEX',
          )
        : node.kind === 'view'
          ? node.value.dependencies
          : node.value.units.flatMap((unit) => unit.dependencies);
    const resolved = dependencies
      .map((edge) => resolveDependency(document, edge))
      .filter((edge) => isIncluded(document, edge))
      .map((edge) => {
        const identity = objectKey(edge.reference);
        return ['PACKAGE', 'FUNCTION', 'PROCEDURE'].includes(edge.type)
          ? `${identity}:${edge.type === 'PACKAGE' ? 'PACKAGE_SPEC' : edge.type}`
          : identity;
      });
    if (node.kind === 'program' && node.value.units[0].type === 'PACKAGE_BODY')
      resolved.push(`${objectKey(node.value.reference)}:PACKAGE_SPEC`);
    edges.set(
      key,
      [
        ...new Set(
          resolved.filter(
            (dependency) => nodes.has(dependency) && dependency !== key,
          ),
        ),
      ].sort(),
    );
  }
  // Tarjan visits dependencies first, so components are already in creation order.
  const indexes = new Map<string, number>(),
    lows = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>();
  const groups: Creation[][] = [];
  let next = 0;
  function visit(key: string): void {
    indexes.set(key, next);
    lows.set(key, next++);
    stack.push(key);
    active.add(key);
    for (const dependency of edges.get(key)!) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lows.set(key, Math.min(lows.get(key)!, lows.get(dependency)!));
      } else if (active.has(dependency))
        lows.set(key, Math.min(lows.get(key)!, indexes.get(dependency)!));
    }
    if (lows.get(key) !== indexes.get(key)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      group.push(member);
    } while (member !== key);
    const values = group.sort().map((id) => nodes.get(id)!);
    if (values.length > 1 && values.some((node) => node.kind !== 'program'))
      throw new Error(
        'UNSUPPORTED_CREATION_CYCLE: Dependency cycle includes a table expression or view.',
      );
    groups.push(values);
  }
  for (const key of [...nodes.keys()].sort()) if (!indexes.has(key)) visit(key);
  return groups;
}
