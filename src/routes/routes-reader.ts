import { tokenText, type GraphReader, type SerializedGraphLike } from '../graph/graph-reader.js';
import { isGraphUnavailable, type GraphClass, type GraphUnavailable } from '../graph/model.js';
import { inScope, type InstanceScope } from '../instance/scope.js';
import type { ApplicationConfigLike } from '../tools/tool-context.js';
import { rawPath, routeVersion, type PathSettings, type VersionValue } from './full-path.js';
import { INSPECTOR_INTERCEPTOR } from '../requests/handler.interceptor.js';
import { TRACE_MIDDLEWARE_NAME } from '../requests/trace.middleware.js';
import type { Enhancer, RouteModel } from './model.js';
import { argumentName, routeArguments } from './route-arguments.js';

type EnhancerKind = 'guard' | 'interceptor' | 'pipe' | 'filter';

interface RawEntrypoint {
  type: string;
  methodName: string;
  className: string;
  classNodeId: string;
  metadata: {
    path: string;
    requestMethod: string;
    methodVersion?: VersionValue;
    controllerVersion?: VersionValue;
    version?: VersionValue;
  };
}

/** A class by its name, an instance by its constructor's, a request-scoped wrapper by its class. */
function enhancerName(value: unknown): string {
  if (typeof value === 'function') return tokenText(value);
  const object = value as { metatype?: unknown; constructor?: { name?: string } };
  if (typeof object?.metatype === 'function') return tokenText(object.metatype);
  return object?.constructor?.name || 'anonymous';
}

/**
 * The globals in `ApplicationConfig`, the order Nest runs them: `useGlobalX` instances and static
 * `APP_X` providers (`getGlobalGuards`), then request-scoped `APP_X` (`getGlobalRequestGuards`).
 * Looked up by name, so a Nest without one of the getters reads as none.
 */
function globals(config: ApplicationConfigLike, kind: EnhancerKind): Enhancer[] {
  const plural = { guard: 'Guards', interceptor: 'Interceptors', pipe: 'Pipes', filter: 'Filters' }[
    kind
  ];
  const read = (method: string): unknown[] => {
    const getter = (config as unknown as Record<string, unknown>)[method];
    return typeof getter === 'function' ? ((getter.call(config) as unknown[]) ?? []) : [];
  };
  // The inspector's own handler interceptor is not part of the app's chain.
  return [...read(`getGlobal${plural}`), ...read(`getGlobalRequest${plural}`)]
    .filter((value) => (value as Record<symbol, unknown> | null)?.[INSPECTOR_INTERCEPTOR] !== true)
    .map((value) => ({ name: enhancerName(value), level: 'global' }));
}

/** Parameter pipes of a handler, by argument index, named after the argument (`'id'`, `#0`). */
function parameterPipes(controller: unknown, handler: string): Enhancer[] {
  return routeArguments(controller, handler).flatMap((argument) =>
    (argument.pipes ?? []).map((pipe) => ({
      name: enhancerName(pipe),
      level: 'method' as const,
      param: argumentName(argument),
    })),
  );
}

/** Removes one occurrence of each name in `names` from `enhancers`. */
function without(enhancers: Enhancer[], names: string[]): Enhancer[] {
  const pending = [...names];
  return enhancers.filter((enhancer) => {
    const index = pending.indexOf(enhancer.name);
    if (index === -1) return true;
    pending.splice(index, 1);
    return false;
  });
}

/**
 * Whether a middleware's class is the one Nest builds around a function middleware. Nest 10 and 11
 * (`mapToClass` in `middleware/utils`) wrap the function in an anonymous class that sets `use` in
 * its constructor and name it with `uid(21)`; the function is only in that closure, so its own name
 * cannot be read back. A class middleware keeps its name, and `use` on its prototype.
 */
function isFunctionalMiddleware(token: unknown): boolean {
  if (typeof token !== 'function') return false;
  const prototype = (token as { prototype?: { use?: unknown } }).prototype;
  return typeof prototype?.use !== 'function' && /^[0-9a-f]{21}$/.test(token.name);
}

/** The stable stand-in for a function middleware: the module whose `configure` applied it. */
function functionalMiddlewareName(module: string | undefined): string {
  return module ? `<functional middleware from ${module}>` : '<functional middleware>';
}

function normalize(path: string): string {
  const trimmed = `/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Whether a middleware's `forRoutes` path and version cover a route. Exact for plain paths; a
 * wildcard (`*`, `(.*)`, `{*splat}`) matches by the prefix before it, which is approximate.
 */
function middlewareMatches(entry: RawEntrypoint, route: RouteModel): boolean {
  const { requestMethod, version } = entry.metadata;
  if (requestMethod !== 'ALL' && requestMethod !== route.method) return false;
  // Nest records the version of the route a middleware was bound to; another version is not it.
  if (
    typeof version === 'string' &&
    typeof route.version === 'string' &&
    route.version !== 'neutral' &&
    version !== route.version
  ) {
    return false;
  }
  const path = entry.metadata.path;
  const wildcard = path.search(/[*(]|\{\*/);
  if (wildcard === -1) return normalize(path) === route.rawPath;
  const prefix = normalize(path.slice(0, wildcard));
  return prefix === '/' || route.rawPath === prefix || route.rawPath.startsWith(`${prefix}/`);
}

/**
 * Every HTTP route Nest registered, from the serialized graph's entrypoints, with the enhancers
 * that run on it: globals from `ApplicationConfig`, controller and method ones from the graph,
 * parameter pipes from the handler's route-arguments metadata.
 */
export class RoutesReader {
  constructor(
    private readonly serializedGraph: SerializedGraphLike | undefined,
    private readonly graph: GraphReader,
    private readonly config: ApplicationConfigLike,
  ) {}

  read(scope: InstanceScope): RouteModel[] | GraphUnavailable {
    const model = this.graph.read();
    if (isGraphUnavailable(model)) return model;
    const json = this.serializedGraph?.toJSON() as
      | { nodes?: Record<string, { metadata?: { token?: unknown } }>; entrypoints?: unknown }
      | undefined;
    const entrypoints = Object.values(
      (json?.entrypoints ?? {}) as Record<string, RawEntrypoint[]>,
    ).flat();
    const middlewares = entrypoints.filter(
      (entry) => entry.type === 'middleware' && entry.className !== TRACE_MIDDLEWARE_NAME,
    );
    const settings: PathSettings = {
      globalPrefix: this.config.getGlobalPrefix(),
      versioning: this.config.getVersioning(),
      exclude: this.config.getGlobalPrefixOptions?.().exclude ?? [],
    };
    const global = {
      guard: globals(this.config, 'guard'),
      interceptor: globals(this.config, 'interceptor'),
      pipe: globals(this.config, 'pipe'),
      filter: globals(this.config, 'filter'),
    };

    const routes: RouteModel[] = [];
    for (const entry of entrypoints) {
      if (entry.type !== 'http-endpoint') continue;
      const controller = model.classes[entry.classNodeId];
      if (!controller) continue;
      const module = model.modules[controller.module]!.name;
      if (!inScope(scope, module)) continue;

      const handler = entry.methodName;
      const bound = (kind: EnhancerKind, methodLevel = enhancersOf(controller, kind, handler)) => [
        ...global[kind],
        ...enhancersOf(controller, kind, undefined),
        ...methodLevel,
      ];
      const params = parameterPipes(json?.nodes?.[entry.classNodeId]?.metadata?.token, handler);
      const { path, requestMethod } = entry.metadata;
      const version = routeVersion(
        entry.metadata.methodVersion ?? entry.metadata.controllerVersion,
        path,
        settings,
      );
      const route: RouteModel = {
        method: requestMethod,
        path,
        rawPath: rawPath(path, requestMethod, version, settings),
        controller: controller.name,
        handler,
        module,
        guards: bound('guard'),
        interceptors: bound('interceptor'),
        // The graph lists parameter pipes among the method's; they run after `@UsePipes` ones.
        pipes: [
          ...bound(
            'pipe',
            without(
              enhancersOf(controller, 'pipe', handler),
              params.map((pipe) => pipe.name),
            ),
          ),
          ...params,
        ],
        filters: bound('filter'),
        middlewares: [],
      };
      if (version !== undefined) route.version = version;
      const matched = new Map<string, string>();
      for (const item of middlewares.filter((entry) => middlewareMatches(entry, route))) {
        const functional = isFunctionalMiddleware(json?.nodes?.[item.classNodeId]?.metadata?.token);
        // A class once by its name; each function middleware once, as there is no name to merge on.
        const key = functional ? `#${item.classNodeId}` : item.className;
        if (matched.has(key)) continue;
        const from = model.classes[item.classNodeId]?.module;
        const module = from === undefined ? undefined : model.modules[from]?.name;
        matched.set(key, functional ? functionalMiddlewareName(module) : item.className);
      }
      route.middlewares = [...matched.values()];
      routes.push(route);
    }
    return routes;
  }
}

/** A controller's enhancers of one kind, at class level (`handler` undefined) or for one handler. */
function enhancersOf(
  controller: GraphClass,
  kind: EnhancerKind,
  handler: string | undefined,
): Enhancer[] {
  const level = handler === undefined ? 'controller' : 'method';
  return (controller.enhancers ?? [])
    .filter((enhancer) => enhancer.subtype === kind && enhancer.methodKey === handler)
    .map((enhancer) => ({ name: enhancer.name, level }));
}
