import type { StackFrame } from '../debug/stack-frames.js';

/** What a step is: an enhancer kind, or the handler itself. */
export type TraceStepKind = 'guard' | 'interceptor' | 'pipe' | 'filter' | 'handler';

/**
 * How a step ended: a guard `allowed` or `denied` (returned false); an interceptor, pipe or
 * handler `ok`; anything that threw `threw`; a filter that handled an exception `caught`.
 */
export type TraceStepOutcome = 'allowed' | 'denied' | 'ok' | 'threw' | 'caught';

export interface TraceError {
  name: string;
  message: string;
  /**
   * With `debug` on: the exception's stack, from the throw outwards, at most `debug.stackFrames`
   * frames. Absent with `debug` off, or when the exception is not an `Error` with a stack.
   */
  stack?: StackFrame[];
}

/** One recorded unit inside a trace. */
export interface TraceStep {
  kind: TraceStepKind;
  /** The enhancer's class name; for the handler, `Controller.handler`. */
  name: string;
  /** Where the enhancer is bound on the route, when the route is known (needs `snapshot`). */
  level?: 'global' | 'controller' | 'method';
  /**
   * Interceptors appear twice: `enter` when `intercept` is called (its duration is the time
   * `intercept` itself took) and `exit` when the Observable it returned answered (its duration
   * spans from `enter`).
   */
  phase?: 'enter' | 'exit';
  /** On an interceptor's `exit`: it answered without calling `next.handle()`. */
  shortCircuited?: true;
  /** Pipes: the argument they transformed (`'id'` for `@Param('id')`), when it has a name. */
  param?: string;
  /** Pipes: `param`, `query`, `body` or `custom`. */
  paramType?: string;
  outcome: TraceStepOutcome;
  error?: TraceError;
  /** Since the trace started. */
  startedAtMs: number;
  durationMs: number;
}

/** What the inspector records about one request. Never its body. */
export interface RequestTrace {
  /** The correlation header's value, or a generated one. */
  id: string;
  method: string;
  /** Path and query string, as the client sent them. */
  url: string;
  /** The route pattern that matched (`/api/cats/:id`), once a route is known. */
  route?: string;
  startedAt: string;
  /** Unset while the request is in flight. */
  durationMs?: number;
  statusCode?: number;
  /** The connection closed before the response finished. */
  aborted?: true;
  controller?: string;
  handler?: string;
  /** Names only (`headers: 'names'`) or names and values (`'full'`); absent with `'none'`. */
  headers?: string[] | Record<string, string>;
  /** In the order they were recorded. */
  steps: TraceStep[];
  /** Steps not recorded because the trace reached its step limit. */
  droppedSteps?: number;
}
