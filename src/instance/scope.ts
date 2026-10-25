import type { GraphModel } from '../graph/model.js';

/**
 * What an instance observes. `app` for `forRoot`; `module` for a `forFeature` instance whose
 * importer was found in the graph; `unresolved` for one whose importer was not (no snapshot, or
 * nothing imports it), which falls back to app scope.
 */
export type InstanceScope =
  | { kind: 'app' }
  | {
      kind: 'module';
      /** The module that imports the instance, by graph name. */
      module: string;
      /** Graph names of that module and everything it imports, transitively. */
      modules: ReadonlySet<string>;
    }
  | { kind: 'unresolved' };

/** The `scope` field of every answer. */
export type AnswerScope =
  | { kind: 'app' }
  | { kind: 'module'; module: string }
  | { kind: 'module'; module: null; error: 'scope_unresolved'; fallback: 'app' };

/**
 * The closure of the modules that import `instanceModuleId`: each importer and every module
 * reachable through imports, excluding Nest's internal modules and the instance's own module.
 * Implicit links to global modules count as imports here: a module can inject what a global module
 * exports without declaring it, so what it can reach includes them. An importer, though, is a
 * module that declares the instance.
 * Several importers (one `forFeature` definition imported twice) join their closures; `module`
 * names the first in graph order.
 */
export function resolveScope(
  graph: GraphModel,
  instanceModuleId: string | undefined,
): InstanceScope {
  if (instanceModuleId === undefined || !(instanceModuleId in graph.modules)) {
    return { kind: 'unresolved' };
  }
  const importers = Object.values(graph.modules).filter((module) =>
    module.imports.includes(instanceModuleId),
  );
  if (importers.length === 0) return { kind: 'unresolved' };

  const reached = new Set<string>();
  const pending = importers.map((module) => module.id);
  while (pending.length > 0) {
    const id = pending.pop()!;
    const module = graph.modules[id];
    if (!module || module.internal || id === instanceModuleId || reached.has(id)) continue;
    reached.add(id);
    pending.push(...module.imports, ...module.globals);
  }
  return {
    kind: 'module',
    module: importers[0]!.name,
    modules: new Set([...reached].map((id) => graph.modules[id]!.name)),
  };
}

/** Whether a module, by graph name, is in the scope. The filter every tool group applies. */
export function inScope(scope: InstanceScope, moduleName: string): boolean {
  return scope.kind !== 'module' || scope.modules.has(moduleName);
}

export function describeScope(scope: InstanceScope): AnswerScope {
  if (scope.kind === 'app') return { kind: 'app' };
  if (scope.kind === 'module') return { kind: 'module', module: scope.module };
  return { kind: 'module', module: null, error: 'scope_unresolved', fallback: 'app' };
}
