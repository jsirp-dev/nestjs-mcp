import { z } from 'zod';
import { findCycles } from '../graph/cycles.js';
import {
  isGraphUnavailable,
  type GraphClass,
  type GraphModel,
  type GraphModule,
  type ProviderScope,
} from '../graph/model.js';
import { describeScope, inScope, type InstanceScope } from '../instance/scope.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

export const SNAPSHOT_HINT = 'Pass { snapshot: true } to NestFactory.create';
const MAX_CANDIDATES = 5;

export interface GraphModuleSummary {
  name: string;
  global: boolean;
  dynamic: boolean;
  providers: number;
  controllers: number;
  imports: string[];
}

export interface GraphModuleDetail {
  name: string;
  global: boolean;
  dynamic: boolean;
  /** What the module declares in its `imports`. */
  imports: string[];
  /** The global modules Nest linked to it without its declaring them. */
  globals: string[];
  exports: string[];
  providers: Array<{ token: string; scope: ProviderScope; exported: boolean }>;
  controllers: string[];
  importedBy: string[];
}

export interface GraphProviderSummary {
  token: string;
  kind: GraphClass['kind'];
  module: string;
  scope: ProviderScope;
  exported: boolean;
  subtype?: string;
  global?: boolean;
}

export interface GraphProviderDetail extends GraphProviderSummary {
  durable: boolean;
  initTimeMs: number;
  /** Tokens this class receives by constructor or property injection. */
  dependsOn: string[];
  /** Tokens of the classes that receive this one by constructor or property injection. */
  dependents: string[];
}

export type GraphCycle =
  | { kind: 'module'; members: string[] }
  | { kind: 'class'; members: Array<{ token: string; module: string }> };

/** Levenshtein distance, case-insensitive. */
function distance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Up to five names close to `wanted`: substrings first, then by edit distance. */
export function similar(wanted: string, names: Iterable<string>): string[] {
  const needle = wanted.toLowerCase();
  const limit = Math.max(3, Math.ceil(wanted.length / 2));
  return [...new Set(names)]
    .map((name) => {
      const haystack = name.toLowerCase();
      const contains = haystack.includes(needle) || needle.includes(haystack);
      return { name, score: contains ? -1 : distance(wanted, name) };
    })
    .filter((candidate) => candidate.score <= limit)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES)
    .map((candidate) => candidate.name);
}

function notFound(what: string, wanted: string, names: Iterable<string>): ToolError {
  return new ToolError('not_found', `No ${what} named ${wanted} in this scope.`, {
    candidates: similar(wanted, names),
  });
}

/**
 * One read of the graph for one tool call, narrowed to the instance's scope, with the lookups
 * every graph tool shares.
 */
class GraphView {
  constructor(
    readonly model: GraphModel,
    readonly scope: InstanceScope,
    readonly includeInternal: boolean,
  ) {}

  /** Whether a module or class shows: in scope, and Nest's own only with `includeInternal`. */
  visible(item: GraphModule | GraphClass): boolean {
    const module = 'kind' in item ? this.model.modules[item.module]! : item;
    return (this.includeInternal || !item.internal) && inScope(this.scope, module.name);
  }

  modules(): GraphModule[] {
    return Object.values(this.model.modules).filter((item) => this.visible(item));
  }

  classes(): GraphClass[] {
    return Object.values(this.model.classes).filter((item) => this.visible(item));
  }

  module(name: string): GraphModule {
    const module = this.modules().find((candidate) => candidate.name === name);
    if (!module) {
      throw notFound(
        'module',
        name,
        this.modules().map((candidate) => candidate.name),
      );
    }
    return module;
  }

  moduleName(id: string): string {
    return this.model.modules[id]!.name;
  }

  /** Names of the given ids that are visible, in order. */
  moduleNames(ids: string[]): string[] {
    return ids
      .map((id) => this.model.modules[id]!)
      .filter((item) => this.visible(item))
      .map((module) => module.name);
  }

  classNames(ids: string[]): string[] {
    return ids
      .map((id) => this.model.classes[id]!)
      .filter((item) => this.visible(item))
      .map((entry) => entry.name);
  }

  /**
   * Constructor and property injections between visible classes; `decorator` edges attach
   * enhancers and are not here.
   */
  injections(): Array<{ from: GraphClass; to: GraphClass }> {
    return this.model.edges
      .filter(
        (edge) =>
          edge.kind === 'class-to-class' &&
          edge.injection !== 'decorator' &&
          (this.includeInternal || !edge.internal),
      )
      .map((edge) => ({ from: this.model.classes[edge.from]!, to: this.model.classes[edge.to]! }))
      .filter(({ from, to }) => this.visible(from) && this.visible(to));
  }
}

function summarizeClass(view: GraphView, entry: GraphClass): GraphProviderSummary {
  const summary: GraphProviderSummary = {
    token: entry.name,
    kind: entry.kind,
    module: view.moduleName(entry.module),
    scope: entry.scope,
    exported: entry.exported,
  };
  if (entry.subtype !== undefined) summary.subtype = entry.subtype;
  if (entry.global) summary.global = true;
  return summary;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function graphModules(view: GraphView): GraphModuleSummary[] {
  return view.modules().map((module) => ({
    name: module.name,
    global: module.global,
    dynamic: module.dynamic,
    providers: view.classNames(module.providers).length,
    controllers: view.classNames(module.controllers).length,
    imports: view.moduleNames(module.imports),
  }));
}

function graphModule(view: GraphView, name: string): GraphModuleDetail {
  const module = view.module(name);
  const providers = module.providers
    .map((id) => view.model.classes[id]!)
    .filter((entry) => view.visible(entry));
  return {
    name: module.name,
    global: module.global,
    dynamic: module.dynamic,
    imports: view.moduleNames(module.imports),
    globals: view.moduleNames(module.globals),
    exports: view.classNames(module.exports),
    providers: providers.map((entry) => ({
      token: entry.name,
      scope: entry.scope,
      exported: entry.exported,
    })),
    controllers: view.classNames(module.controllers),
    importedBy: view
      .modules()
      .filter((candidate) => candidate.imports.includes(module.id))
      .map((candidate) => candidate.name),
  };
}

function graphProviders(
  view: GraphView,
  input: { filter?: string; module?: string; scope?: ProviderScope },
): GraphProviderSummary[] {
  const moduleId = input.module === undefined ? undefined : view.module(input.module).id;
  const needle = input.filter?.toLowerCase();
  return view
    .classes()
    .filter((entry) => entry.kind !== 'controller')
    .filter((entry) => moduleId === undefined || entry.module === moduleId)
    .filter((entry) => input.scope === undefined || entry.scope === input.scope)
    .filter((entry) => needle === undefined || entry.name.toLowerCase().includes(needle))
    .map((entry) => summarizeClass(view, entry));
}

function graphProvider(
  view: GraphView,
  input: { token: string; module?: string },
): GraphProviderDetail {
  const moduleId = input.module === undefined ? undefined : view.module(input.module).id;
  const inModule = view
    .classes()
    .filter((entry) => moduleId === undefined || entry.module === moduleId);
  const matches = inModule.filter((entry) => entry.name === input.token);
  if (matches.length === 0) {
    throw notFound(
      'provider',
      input.token,
      inModule.map((entry) => entry.name),
    );
  }
  if (matches.length > 1) {
    throw new ToolError(
      'ambiguous',
      `${input.token} is declared in ${matches.length} modules; pass module to pick one.`,
      {
        candidates: matches.map((entry) => ({
          token: entry.name,
          module: view.moduleName(entry.module),
        })),
      },
    );
  }
  const entry = matches[0]!;
  const injections = view.injections();
  return {
    ...summarizeClass(view, entry),
    durable: entry.durable,
    initTimeMs: entry.initTimeMs,
    dependsOn: unique(injections.filter(({ from }) => from === entry).map(({ to }) => to.name)),
    dependents: unique(injections.filter(({ to }) => to === entry).map(({ from }) => from.name)),
  };
}

function graphCycles(view: GraphView): GraphCycle[] {
  const modules = view.modules();
  const visibleModules = new Set(modules.map((module) => module.id));
  const moduleCycles = findCycles(
    modules.map((module) => module.id),
    view.model.edges
      .filter(
        (edge) =>
          edge.kind === 'module-to-module' &&
          // Nest links every module to every global one, so these always close a loop.
          edge.implicit !== true &&
          visibleModules.has(edge.from) &&
          visibleModules.has(edge.to),
      )
      .map((edge): [string, string] => [edge.from, edge.to]),
  ).map((members): GraphCycle => ({ kind: 'module', members: members.map(view.moduleName, view) }));

  const classCycles = findCycles(
    view.classes().map((entry) => entry.id),
    view.injections().map(({ from, to }): [string, string] => [from.id, to.id]),
  ).map((members): GraphCycle => ({
    kind: 'class',
    members: members.map((id) => {
      const entry = view.model.classes[id]!;
      return { token: entry.name, module: view.moduleName(entry.module) };
    }),
  }));

  return [...moduleCycles, ...classCycles];
}

const includeInternal = z
  .boolean()
  .optional()
  .describe("Show Nest's own modules and providers (InternalCoreModule, ModuleRef, ...).");

export function registerGraphTools(registry: ToolRegistry, context: ToolContext): void {
  /** Reads the graph once for the call, in the instance's scope, or fails with `snapshot_disabled`. */
  const view = (input: Record<string, unknown>): GraphView => {
    const model = context.graph.read();
    if (isGraphUnavailable(model)) {
      throw new ToolError('snapshot_disabled', SNAPSHOT_HINT, { scope: scope() });
    }
    return new GraphView(model, context.scope(), input.includeInternal === true);
  };
  const scope = () => describeScope(context.scope());

  registry.register('graph', {
    name: 'graph_modules',
    description:
      'The modules Nest built in this scope: whether each is global or dynamic, how many ' +
      'providers and controllers it declares, and what it imports.',
    inputSchema: { includeInternal },
    handler: (input) => ({ scope: scope(), modules: graphModules(view(input)) }),
  });

  registry.register('graph', {
    name: 'graph_module',
    description:
      'One module by class name: its imports, exports, providers (with scope and whether ' +
      'exported), controllers, and the modules that import it. Names shared by several ' +
      'modules carry a #n suffix, as graph_modules lists them.',
    inputSchema: {
      name: z.string().describe('Module class name, e.g. AppModule'),
      includeInternal,
    },
    handler: (input) => ({
      scope: scope(),
      module: graphModule(view(input), String(input.name)),
    }),
  });

  registry.register('graph', {
    name: 'graph_providers',
    description:
      'Providers and injectables (guards, interceptors, pipes, filters, marked by subtype) in ' +
      'this scope, optionally filtered by a case-insensitive substring of the token, by module ' +
      'or by injection scope.',
    inputSchema: {
      filter: z.string().optional().describe('Case-insensitive substring of the token'),
      module: z.string().optional().describe('Only providers declared in this module'),
      scope: z.enum(['DEFAULT', 'REQUEST', 'TRANSIENT']).optional(),
      includeInternal,
    },
    handler: (input) => ({
      scope: scope(),
      providers: graphProviders(view(input), {
        filter: input.filter as string | undefined,
        module: input.module as string | undefined,
        scope: input.scope as ProviderScope | undefined,
      }),
    }),
  });

  registry.register('graph', {
    name: 'graph_provider',
    description:
      'One provider, injectable or controller by token: its module, injection scope, what it ' +
      'depends on and who depends on it (constructor and property injection), and how long it ' +
      'took to instantiate. Pass module when the token is declared in several modules.',
    inputSchema: {
      token: z.string().describe('Class name, or the description of a string or symbol token'),
      module: z.string().optional().describe('The declaring module, to disambiguate'),
      includeInternal,
    },
    handler: (input) => ({
      scope: scope(),
      provider: graphProvider(view(input), {
        token: String(input.token),
        module: input.module as string | undefined,
      }),
    }),
  });

  registry.register('graph', {
    name: 'graph_cycles',
    description:
      'Import cycles between modules and injection cycles between classes in this scope; an ' +
      'empty list when there are none.',
    handler: () => ({ scope: scope(), cycles: graphCycles(view({})) }),
  });
}
