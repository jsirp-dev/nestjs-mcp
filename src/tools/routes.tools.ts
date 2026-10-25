import { z } from 'zod';
import { describeScope } from '../instance/scope.js';
import type { RouteModel } from '../routes/model.js';
import { SNAPSHOT_HINT, similar } from './graph.tools.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

export interface RouteSummary {
  method: string;
  path: string;
  /** `Controller.handler` */
  handler: string;
  guards: number;
  interceptors: number;
  pipes: number;
  filters: number;
}

function summarize(route: RouteModel): RouteSummary {
  return {
    method: route.method,
    path: route.path,
    handler: `${route.controller}.${route.handler}`,
    guards: route.guards.length,
    interceptors: route.interceptors.length,
    pipes: route.pipes.length,
    filters: route.filters.length,
  };
}

function routesList(
  routes: RouteModel[],
  input: { filter?: string; method?: string; controller?: string; module?: string },
): RouteSummary[] {
  const needle = input.filter?.toLowerCase();
  const method = input.method?.toUpperCase();
  return routes
    .filter((route) => method === undefined || route.method === method)
    .filter((route) => input.controller === undefined || route.controller === input.controller)
    .filter((route) => input.module === undefined || route.module === input.module)
    .filter(
      (route) =>
        needle === undefined ||
        [route.path, route.rawPath, `${route.controller}.${route.handler}`].some((text) =>
          text.toLowerCase().includes(needle),
        ),
    )
    .map(summarize);
}

function routeGet(routes: RouteModel[], input: { method: string; path: string }): RouteModel {
  const method = input.method.toUpperCase();
  const path = `/${input.path.replace(/^\/+/, '')}`.replace(/(.)\/+$/, '$1');
  const sameMethod = routes.filter((route) => route.method === method);
  const exact = sameMethod.filter((route) => route.path === path);
  const matches = exact.length > 0 ? exact : sameMethod.filter((route) => route.rawPath === path);
  if (matches.length === 1) return matches[0]!;

  const label = (route: RouteModel) => `${route.method} ${route.path}`;
  if (matches.length > 1) {
    throw new ToolError(
      'ambiguous',
      `${method} ${path} is the raw path of ${matches.length} routes; pass one full path.`,
      { candidates: matches.map(label) },
    );
  }
  throw new ToolError('not_found', `No ${method} route at ${path} in this scope.`, {
    candidates: similar(`${method} ${path}`, routes.map(label)),
  });
}

export function registerRoutesTools(registry: ToolRegistry, context: ToolContext): void {
  const scope = () => describeScope(context.scope());
  const read = (): RouteModel[] => {
    const routes = context.routes.read(context.scope());
    if (!Array.isArray(routes)) {
      throw new ToolError('snapshot_disabled', SNAPSHOT_HINT, { scope: scope() });
    }
    return routes;
  };

  registry.register('routes', {
    name: 'routes_list',
    description:
      'The HTTP routes Nest registered in this scope, one per method and full path (global prefix ' +
      'and URI version included), with Controller.handler and how many guards, interceptors, ' +
      'pipes and filters run on each. Optionally filtered by a case-insensitive substring of the ' +
      'path or handler, by method, controller or module.',
    inputSchema: {
      filter: z.string().optional().describe('Case-insensitive substring of the path or handler'),
      method: z.string().optional().describe('HTTP method, e.g. GET'),
      controller: z.string().optional().describe('Controller class name'),
      module: z.string().optional().describe('Module that declares the controller'),
    },
    handler: (input) => ({
      scope: scope(),
      routes: routesList(read(), {
        filter: input.filter as string | undefined,
        method: input.method as string | undefined,
        controller: input.controller as string | undefined,
        module: input.module as string | undefined,
      }),
    }),
  });

  registry.register('routes', {
    name: 'route_get',
    description:
      'One route by method and path (the full path, /api/v1/cats/:id, or the raw one, /cats/:id): ' +
      'its controller, handler, module and version, and the guards, interceptors, pipes (with the ' +
      'parameter they transform) and exception filters Nest runs on it, each with its level, in ' +
      'execution order global → controller → method. Filters are listed in that order too, but ' +
      'Nest tries them the other way round. middlewares are matched by path, approximately; a ' +
      'function middleware has no name Nest keeps, so it reads <functional middleware from Module>.',
    inputSchema: {
      method: z.string().describe('HTTP method, e.g. GET'),
      path: z.string().describe('Full or raw path with Nest parameters, e.g. /api/cats/:id'),
    },
    handler: (input) => ({
      scope: scope(),
      route: routeGet(read(), { method: String(input.method), path: String(input.path) }),
      middlewaresMatch: 'approximate',
    }),
  });
}
