import { z } from 'zod';
import { describeScope, inScope, type AnswerScope, type InstanceScope } from '../instance/scope.js';
import type { RequestTrace, TraceStep } from '../requests/model.js';
import type { TraceRecorder } from '../requests/trace-recorder.js';
import type { Enhancer, RouteModel } from '../routes/model.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface RequestsListInput {
  limit?: number;
  method?: string;
  path?: string;
  status?: number;
  minStatus?: number;
  scope?: 'instance' | 'app';
}

export interface RequestSummary {
  id: string;
  method: string;
  url: string;
  startedAt: string;
  statusCode?: number;
  durationMs?: number;
  inFlight?: true;
  aborted?: true;
  /** `Controller.handler`, once a route was matched. */
  handler?: string;
  module?: string;
  steps: number;
}

/** A trace as `request_trace` answers it: levels, module and untraced enhancers filled in. */
export interface RequestTraceAnswer extends RequestTrace {
  module?: string;
  inFlight?: true;
  /** Enhancers on this route with no long-lived instance (`REQUEST`, `TRANSIENT`): not traced. */
  notTraced?: string[];
}

/** The routes Nest registered, to find the one a trace went through (needs `snapshot`). */
class RouteIndex {
  private readonly byPath = new Map<string, RouteModel>();
  private readonly byHandler = new Map<string, RouteModel>();

  constructor(routes: RouteModel[]) {
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (!this.byPath.has(key)) this.byPath.set(key, route);
      const handler = `${route.controller}.${route.handler}`;
      if (!this.byHandler.has(handler)) this.byHandler.set(handler, route);
    }
  }

  find(trace: RequestTrace): RouteModel | undefined {
    if (trace.controller === undefined) return undefined;
    const handler = `${trace.controller}.${trace.handler}`;
    const byPath =
      trace.route === undefined
        ? undefined
        : (this.byPath.get(`${trace.method} ${trace.route}`) ??
          this.byPath.get(`ALL ${trace.route}`));
    // The path is the precise key; the handler disambiguates nothing it would not.
    if (byPath && `${byPath.controller}.${byPath.handler}` === handler) return byPath;
    return this.byHandler.get(handler);
  }
}

function routeIndex(context: ToolContext): RouteIndex | undefined {
  const routes = context.routes.read({ kind: 'app' });
  return Array.isArray(routes) ? new RouteIndex(routes) : undefined;
}

/** Whether a trace is visible from a scope: a module scope sees traces of its own controllers. */
function visible(scope: InstanceScope, route: RouteModel | undefined): boolean {
  if (scope.kind !== 'module') return true;
  return route !== undefined && inScope(scope, route.module);
}

function chainOf(route: RouteModel, kind: TraceStep['kind']): Enhancer[] {
  if (kind === 'guard') return route.guards;
  if (kind === 'interceptor') return route.interceptors;
  if (kind === 'pipe') return route.pipes;
  if (kind === 'filter') return route.filters;
  return [];
}

function levelOf(route: RouteModel, step: TraceStep): Enhancer['level'] | undefined {
  const chain = chainOf(route, step.kind).filter((enhancer) => enhancer.name === step.name);
  if (step.kind === 'pipe') {
    const forParam = chain.find(
      (enhancer) => enhancer.param !== undefined && enhancer.param === step.param,
    );
    return (forParam ?? chain.find((enhancer) => enhancer.param === undefined))?.level;
  }
  return chain[0]?.level;
}

function present(
  trace: RequestTrace,
  route: RouteModel | undefined,
  untraced: ReadonlySet<string>,
): RequestTraceAnswer {
  const steps = trace.steps.map((step) => {
    const level = route ? levelOf(route, step) : undefined;
    return level === undefined ? { ...step } : { ...step, level };
  });
  const answer: RequestTraceAnswer = {
    ...trace,
    ...(Array.isArray(trace.headers)
      ? { headers: [...trace.headers] }
      : trace.headers
        ? { headers: { ...trace.headers } }
        : {}),
    steps,
  };
  if (trace.durationMs === undefined) answer.inFlight = true;
  if (route) {
    answer.module = route.module;
    const onRoute = [...route.guards, ...route.interceptors, ...route.pipes, ...route.filters];
    const notTraced = [...new Set(onRoute.map((enhancer) => enhancer.name))].filter((name) =>
      untraced.has(name),
    );
    if (notTraced.length > 0) answer.notTraced = notTraced;
  }
  return answer;
}

function summarize(trace: RequestTrace, route: RouteModel | undefined): RequestSummary {
  const summary: RequestSummary = {
    id: trace.id,
    method: trace.method,
    url: trace.url,
    startedAt: trace.startedAt,
    steps: trace.steps.length,
  };
  if (trace.statusCode !== undefined) summary.statusCode = trace.statusCode;
  if (trace.durationMs !== undefined) summary.durationMs = trace.durationMs;
  else summary.inFlight = true;
  if (trace.aborted) summary.aborted = true;
  if (trace.controller !== undefined) summary.handler = `${trace.controller}.${trace.handler}`;
  if (route) summary.module = route.module;
  return summary;
}

export function registerRequestsTools(registry: ToolRegistry, context: ToolContext): void {
  const recorder = (): TraceRecorder => {
    if (!context.traces) {
      throw new ToolError(
        'requests_not_installed',
        'Request tracing is installed while the app initialises; call again once it has.',
      );
    }
    return context.traces;
  };
  const scopeFor = (lift: boolean): { scope: InstanceScope; answer: AnswerScope } => {
    if (lift) return { scope: { kind: 'app' }, answer: { kind: 'app' } };
    const scope = context.scope();
    return { scope, answer: describeScope(scope) };
  };
  const scopeInput = z
    .enum(['instance', 'app'])
    .optional()
    .describe("'app' sees every trace, even from a module-scoped instance");

  registry.register('requests', {
    name: 'requests_list',
    description:
      'The latest HTTP requests the app served, oldest first: id, method, full URL, status, ' +
      'duration, Controller.handler, module and how many steps were recorded. In-flight requests ' +
      'show inFlight: true. Filter by method, a substring of the URL, exact status or minimum ' +
      'status. Set the correlation header (x-nest-mcp-request-id by default) on a request to ' +
      'know its id beforehand; otherwise find it here. A module-scoped instance lists only ' +
      "requests whose handler is in its scope; scope: 'app' lifts that. The inspector's own " +
      'endpoints are never traced.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`At most this many requests (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      method: z.string().optional().describe('HTTP method, case-insensitive'),
      path: z.string().optional().describe('Substring of the URL (path and query)'),
      status: z.number().int().optional().describe('Exact response status'),
      minStatus: z.number().int().optional().describe('This status or higher (400 for failures)'),
      scope: scopeInput,
    },
    handler: (input) => {
      const typed = input as RequestsListInput;
      const traces = recorder().traces();
      const { scope, answer } = scopeFor(typed.scope === 'app');
      const index = routeIndex(context);
      const method = typed.method?.toUpperCase();
      const matching = traces
        .map((trace) => ({ trace, route: index?.find(trace) }))
        .filter(
          ({ trace, route }) =>
            visible(scope, route) &&
            (method === undefined || trace.method.toUpperCase() === method) &&
            (typed.path === undefined || trace.url.includes(typed.path)) &&
            (typed.status === undefined || trace.statusCode === typed.status) &&
            (typed.minStatus === undefined ||
              (trace.statusCode !== undefined && trace.statusCode >= typed.minStatus)),
        );
      const limit = typed.limit ?? DEFAULT_LIMIT;
      return {
        scope: answer,
        requests: matching.slice(-limit).map(({ trace, route }) => summarize(trace, route)),
        matched: matching.length,
      };
    },
  });

  registry.register('requests', {
    name: 'request_trace',
    description:
      'The full trace of one request by id: method, full URL, status, duration, controller, ' +
      'handler, module, request headers per the requests.headers option, and the steps in the ' +
      'order they were recorded: each guard (allowed, denied or threw), each interceptor twice ' +
      '(enter, then exit when its Observable answered), each pipe with the parameter it ' +
      'transformed, the handler, and any exception filter that caught, with timings. Request ' +
      'bodies are never stored. Enhancers with no long-lived instance (REQUEST or TRANSIENT ' +
      'scope) are listed in notTraced. With several traces sharing an id, the latest.',
    inputSchema: {
      id: z.string().min(1).describe('The correlation header value, or an id from requests_list'),
      scope: scopeInput,
    },
    handler: (input) => {
      const { id, scope: lift } = input as { id: string; scope?: 'instance' | 'app' };
      const active = recorder();
      const { scope, answer } = scopeFor(lift === 'app');
      const trace = active
        .traces()
        .reverse()
        .find((candidate) => candidate.id === id);
      if (!trace) {
        throw new ToolError(
          'not_found',
          `No trace with id ${id}. The buffer keeps the last ${active.buffer.size} requests; ` +
            'requests_list shows the ids it holds.',
          { scope: answer },
        );
      }
      const route = routeIndex(context)?.find(trace);
      if (!visible(scope, route)) {
        throw new ToolError(
          'not_found',
          `The trace ${id} is outside this instance's scope; pass scope: 'app' to read it.`,
          { scope: answer },
        );
      }
      return { scope: answer, trace: present(trace, route, active.untraced) };
    },
  });
}
