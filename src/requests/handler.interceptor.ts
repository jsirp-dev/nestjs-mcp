import { performance } from 'node:perf_hooks';
import { tap, type Observable } from 'rxjs';
import type { TraceStep } from './model.js';
import {
  MAX_STEPS,
  current,
  describeError,
  elapsed,
  identify,
  round,
  type ActiveTrace,
} from './trace-context.js';

/** Marks the inspector's own interceptor, so the routes group can leave it out of the globals. */
export const INSPECTOR_INTERCEPTOR = Symbol.for('nestjs-mcp.handler-interceptor');

interface CallHandlerLike {
  handle(): Observable<unknown>;
}

/** Whether something between `from` and the end kept the handler from running. */
function handlerSkipped(steps: TraceStep[], from: number): boolean {
  return steps
    .slice(from)
    .some(
      (step) =>
        (step.kind === 'pipe' && step.outcome === 'threw') ||
        (step.kind === 'interceptor' && step.phase === 'enter' && step.outcome === 'threw') ||
        (step.kind === 'interceptor' && step.phase === 'exit' && step.shortCircuited === true),
    );
}

/**
 * Records the handler step once the chain below this interceptor answered. The step goes before
 * the `exit` of the interceptors inside it, where the handler ran, and spans from the end of the
 * last step before it (a pipe, usually) to the first of those exits.
 */
function recordHandler(
  active: ActiveTrace,
  from: number,
  start: number,
  outcome: 'ok' | 'threw',
  error?: unknown,
): void {
  const { trace } = active;
  if (handlerSkipped(trace.steps, from)) return;
  const steps = trace.steps;
  if (steps.length >= MAX_STEPS) {
    trace.droppedSteps = (trace.droppedSteps ?? 0) + 1;
    return;
  }
  let at = steps.findIndex((step, index) => index >= from && step.phase === 'exit');
  if (at === -1) at = steps.length;
  const before = steps.slice(from, at);
  const startedAtMs = Math.max(
    elapsed(active, start),
    ...before.map((step) => round(step.startedAtMs + step.durationMs)),
  );
  const endedAtMs =
    at < steps.length ? round(steps[at]!.startedAtMs + steps[at]!.durationMs) : elapsed(active);
  const step: TraceStep = {
    kind: 'handler',
    name: `${trace.controller ?? 'anonymous'}.${trace.handler ?? 'anonymous'}`,
    outcome,
    ...(error === undefined ? {} : { error: describeError(error) }),
    startedAtMs,
    durationMs: round(Math.max(0, endedAtMs - startedAtMs)),
  };
  steps.splice(at, 0, step);
}

/**
 * Added by the inspector to the app's global interceptors when request tracing is on. It names
 * the controller, handler and route of the trace and records the handler as a step.
 */
export class NestMcpHandlerInterceptor {
  readonly [INSPECTOR_INTERCEPTOR] = true;

  intercept(context: unknown, next: CallHandlerLike): Observable<unknown> {
    const active = current();
    if (!active) return next.handle();
    identify(active, context);
    const from = active.trace.steps.length;
    const start = performance.now();
    let done = false;
    const finish = (outcome: 'ok' | 'threw', error?: unknown) => {
      if (done) return;
      done = true;
      recordHandler(active, from, start, outcome, error);
    };
    return next.handle().pipe(
      tap({
        next: () => finish('ok'),
        error: (error: unknown) => finish('threw', error),
        complete: () => finish('ok'),
      }),
    );
  }
}
