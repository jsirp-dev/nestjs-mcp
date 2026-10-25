import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { RequestTrace, TraceError, TraceStep } from './model.js';

/** A trace while its request runs: the public record and the clock it is measured against. */
export interface ActiveTrace {
  trace: RequestTrace;
  /** `performance.now()` when the trace started. */
  t0: number;
}

/** Steps kept per trace; a request that records more keeps the first ones and counts the rest. */
export const MAX_STEPS = 256;

const storage = new AsyncLocalStorage<ActiveTrace>();

/** The trace of the request running in this async context, if one is being traced. */
export function current(): ActiveTrace | undefined {
  return storage.getStore();
}

/** Runs `fn` with `active` as the current trace for everything it starts. */
export function runWithTrace<T>(active: ActiveTrace, fn: () => T): T {
  return storage.run(active, fn);
}

/** Milliseconds since the trace started, rounded to microseconds. */
export function elapsed(active: ActiveTrace, at = performance.now()): number {
  return round(at - active.t0);
}

export function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Appends a step, or counts it as dropped when the trace is full. Returns it when kept. */
export function record(active: ActiveTrace, step: TraceStep): TraceStep | undefined {
  const { trace } = active;
  if (trace.steps.length >= MAX_STEPS) {
    trace.droppedSteps = (trace.droppedSteps ?? 0) + 1;
    return undefined;
  }
  trace.steps.push(step);
  return step;
}

/** An exception as a trace keeps it: its name (the class for Nest's exceptions) and message. */
export function describeError(error: unknown): TraceError {
  if (error instanceof Error) {
    return { name: error.name || error.constructor.name, message: error.message };
  }
  const object = error as { name?: unknown; message?: unknown } | null;
  return {
    name: typeof object?.name === 'string' ? object.name : typeof error,
    message: typeof object?.message === 'string' ? object.message : String(error),
  };
}

/** What a trace reads from an `ExecutionContext`. Duck-typed on purpose. */
interface ExecutionContextLike {
  getType?(): string;
  getClass?(): unknown;
  getHandler?(): unknown;
  switchToHttp?(): { getRequest(): unknown };
}

/** Fills controller, handler and route from the first HTTP execution context that has them. */
export function identify(active: ActiveTrace, context: unknown): void {
  const { trace } = active;
  if (trace.controller !== undefined) return;
  const ctx = context as ExecutionContextLike | undefined;
  if (typeof ctx?.getClass !== 'function' || typeof ctx.getHandler !== 'function') return;
  if (typeof ctx.getType === 'function' && ctx.getType() !== 'http') return;
  const controller = ctx.getClass() as { name?: string } | undefined;
  const handler = ctx.getHandler() as { name?: string } | undefined;
  if (typeof controller?.name === 'string') trace.controller = controller.name;
  if (typeof handler?.name === 'string') trace.handler = handler.name;
  const request = ctx.switchToHttp?.().getRequest() as { route?: { path?: unknown } } | undefined;
  if (typeof request?.route?.path === 'string') trace.route = request.route.path;
}
