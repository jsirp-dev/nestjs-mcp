import { nestVersion } from '../support/package-info.js';
import { NestMcpHandlerInterceptor } from './handler.interceptor.js';
import { runWithTrace } from './trace-context.js';
import {
  TraceRecorder,
  type IncomingRequestLike,
  type OutgoingResponseLike,
  type TraceRecorderOptions,
} from './trace-recorder.js';
import { wrapEnhancers, type ModulesContainerLike } from './wrap-enhancers.js';

/** The name the inspector's middleware has in Nest's graph, left out of `routes_*` answers. */
export const TRACE_MIDDLEWARE_NAME = 'NestMcpTraceMiddleware';

/** What the installer needs from Nest's `MiddlewareConsumer`. */
export interface MiddlewareConsumerLike {
  apply(...middleware: unknown[]): { forRoutes(...routes: unknown[]): unknown };
}

/** What the installer needs from Nest's `ApplicationConfig`, besides the globals it wraps. */
export interface TracingApplicationConfigLike {
  addGlobalInterceptor?(interceptor: unknown): void;
}

/**
 * A middleware class of this app's own, closing over its recorder: it opens each request's trace
 * and runs the rest of the request inside it. A class, because Nest names a functional middleware
 * with a random token, and the routes group recognises this one by its name.
 */
export function createTraceMiddleware(recorder: TraceRecorder) {
  class NestMcpTraceMiddleware {
    use(request: IncomingRequestLike, response: OutgoingResponseLike, next: () => void): void {
      const active = recorder.start(request, response);
      if (!active) return next();
      runWithTrace(active, next);
    }
  }
  // Pinned: a bundler may rename a nested class.
  Object.defineProperty(NestMcpTraceMiddleware, 'name', { value: TRACE_MIDDLEWARE_NAME });
  return NestMcpTraceMiddleware;
}

/**
 * Every path, in the syntax of the running Nest: Nest 11 (path-to-regexp 8) wants a named
 * wildcard and warns about a bare `*` under a global prefix; Nest 10 only knows the bare `*`.
 */
export function everyRoute(version = nestVersion()): string {
  const major = Number.parseInt(version, 10);
  return Number.isNaN(major) || major >= 11 ? '{*path}' : '*';
}

/** One recorder per app, found by the app's `ApplicationConfig`. */
const recorders = new WeakMap<object, TraceRecorder>();

export interface InstallTracingInput {
  options: TraceRecorderOptions;
  modulesContainer: ModulesContainerLike;
  applicationConfig: TracingApplicationConfigLike;
  consumer: MiddlewareConsumerLike;
  /** The calling instance's endpoint, global prefix included: never traced. */
  mcpPath: string;
}

/**
 * Installs request tracing in an app, once: the first instance with the `requests` group on
 * wraps the enhancers, adds the handler interceptor to the globals and applies the middleware to
 * every route; every later instance of the same app joins its recorder and excludes its endpoint.
 * Runs from `configure`, before Nest builds the routes, which bind exception filters for good.
 */
export function installRequestTracing(input: InstallTracingInput): TraceRecorder {
  const known = recorders.get(input.applicationConfig);
  if (known) {
    known.exclude(input.mcpPath);
    return known;
  }
  const recorder = new TraceRecorder(input.options);
  recorder.exclude(input.mcpPath);
  const report = wrapEnhancers(
    input.modulesContainer,
    input.applicationConfig,
    (instance) => instance instanceof NestMcpHandlerInterceptor,
  );
  for (const name of report.untraced) recorder.untraced.add(name);
  input.applicationConfig.addGlobalInterceptor?.(new NestMcpHandlerInterceptor());
  input.consumer.apply(createTraceMiddleware(recorder)).forRoutes(everyRoute());
  recorders.set(input.applicationConfig, recorder);
  return recorder;
}
