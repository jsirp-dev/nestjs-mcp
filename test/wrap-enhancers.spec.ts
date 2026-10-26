import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { UsePipes } from '@nestjs/common';
import { Observable, isObservable, lastValueFrom, of, take, tap, throwError } from 'rxjs';
import type { RequestTrace } from '../src/requests/model.js';
import { current, runWithTrace, type ActiveTrace } from '../src/requests/trace-context.js';
import { everyRoute } from '../src/requests/trace.middleware.js';
import {
  WRAPPED,
  isWrapped,
  wrapEnhancers,
  wrapInstance,
  type InstanceWrapperLike,
} from '../src/requests/wrap-enhancers.js';

function newTrace(): ActiveTrace {
  const trace: RequestTrace = {
    id: 't',
    method: 'GET',
    url: '/',
    startedAt: new Date().toISOString(),
    steps: [],
  };
  return { trace, t0: performance.now() };
}

/** Runs `fn` inside a fresh trace and answers what it returned and the steps recorded. */
function traced<T>(fn: () => T): { result: T; steps: RequestTrace['steps'] } {
  const active = newTrace();
  const result = runWithTrace(active, {}, fn);
  return { result, steps: active.trace.steps };
}

class Flag {
  constructor(readonly open: boolean) {}
}

/** A guard whose answer depends on an injected property, in every shape Nest accepts. */
class FlagGuard {
  constructor(
    private readonly flag: Flag,
    private readonly shape: 'sync' | 'promise' | 'observable',
  ) {}

  canActivate(): unknown {
    if (this.shape === 'promise') return Promise.resolve(this.flag.open);
    if (this.shape === 'observable') return of(this.flag.open);
    return this.flag.open;
  }
}

describe('wrapInstance', () => {
  it('keeps return values and this for every guard shape, in and out of a trace', async () => {
    for (const shape of ['sync', 'promise', 'observable'] as const) {
      for (const open of [true, false]) {
        const guard = new FlagGuard(new Flag(open), shape);
        expect(wrapInstance(guard)).toBe(true);

        const outside = guard.canActivate();
        const { result, steps } = traced(() => guard.canActivate());
        const settle = async (value: unknown) =>
          isObservable(value) ? lastValueFrom(value) : await value;
        expect(isObservable(result)).toBe(shape === 'observable');
        expect(result instanceof Promise).toBe(shape === 'promise');
        expect(await settle(outside)).toBe(open);
        expect(await settle(result)).toBe(open);
        expect(steps.map((step) => [step.kind, step.name, step.outcome])).toEqual([
          ['guard', 'FlagGuard', open ? 'allowed' : 'denied'],
        ]);
      }
    }
  });

  it('rethrows the very same exception and records it', () => {
    const boom = new Error('closed');
    const guard = {
      boom,
      canActivate(this: { boom: Error }) {
        throw this.boom;
      },
    };
    wrapInstance(guard);
    let thrown: unknown;
    const { steps } = traced(() => {
      try {
        guard.canActivate();
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBe(boom);
    expect(steps[0]).toMatchObject({
      outcome: 'threw',
      error: { name: 'Error', message: 'closed' },
    });
  });

  it('records an interceptor on enter and on exit, and a short-circuit', async () => {
    const passThrough = {
      intercept: (_context: unknown, next: { handle(): Observable<unknown> }) => next.handle(),
    };
    const cached = { intercept: () => of('cached') };
    wrapInstance(passThrough);
    wrapInstance(cached);
    const next = { handle: () => of('fresh') };

    const pass = traced(() => passThrough.intercept(undefined, next));
    expect(await lastValueFrom(pass.result)).toBe('fresh');
    expect(pass.steps.map((step) => [step.phase, step.outcome, step.shortCircuited])).toEqual([
      ['enter', 'ok', undefined],
      ['exit', 'ok', undefined],
    ]);

    const short = traced(() => cached.intercept());
    expect(await lastValueFrom(short.result as Observable<unknown>)).toBe('cached');
    expect(short.steps[1]).toMatchObject({ phase: 'exit', shortCircuited: true });

    const failing = traced(() =>
      passThrough.intercept(undefined, { handle: () => throwError(() => new TypeError('x')) }),
    );
    await expect(lastValueFrom(failing.result)).rejects.toThrow('x');
    expect(failing.steps[1]).toMatchObject({ phase: 'exit', outcome: 'threw' });
  });

  it("runs an interceptor's exit phase in its trace when subscribed outside it, untouched", async () => {
    const seen: Array<string | undefined> = [];
    const after = {
      intercept: (_context: unknown, next: { handle(): Observable<number> }) =>
        next.handle().pipe(tap(() => seen.push(current()?.trace.id))),
    };
    wrapInstance(after);
    let subscriptions = 0;
    let teardowns = 0;
    const source = new Observable<number>((subscriber) => {
      subscriptions += 1;
      subscriber.next(1);
      subscriber.next(2);
      return () => (teardowns += 1);
    });

    // Subscribed after `traced` returned: outside the trace's async context, as Nest's router does.
    const { result } = traced(() => after.intercept(undefined, { handle: () => source }));
    expect(result).toBeInstanceOf(Observable);
    expect(current()).toBeUndefined();
    const values: number[] = [];
    const subscription = result.subscribe((value) => values.push(value));
    expect(values).toEqual([1, 2]);
    expect(seen).toEqual(['t', 't']);
    expect(current()).toBeUndefined();
    subscription.unsubscribe();
    expect(teardowns).toBe(1);

    // Each subscription subscribes the source again, and completion and errors pass through.
    expect(await lastValueFrom(result.pipe(take(1)))).toBe(1);
    expect(subscriptions).toBe(2);
    const failing = traced(() =>
      after.intercept(undefined, { handle: () => throwError(() => new TypeError('y')) }),
    );
    await expect(lastValueFrom(failing.result)).rejects.toThrow(TypeError);
  });

  it('records a pipe without its value and passes the value untouched', () => {
    const value = { untouched: true };
    const pipe = { transform: (input: unknown, _metadata: { type: string }) => input };
    wrapInstance(pipe);
    const { result, steps } = traced(() => pipe.transform(value, { type: 'body' }));
    expect(result).toBe(value);
    expect(steps).toEqual([
      expect.objectContaining({ kind: 'pipe', paramType: 'body', outcome: 'ok' }),
    ]);
    expect(JSON.stringify(steps)).not.toContain('untouched');
  });

  it('is idempotent and leaves frozen instances alone', () => {
    const guard = new FlagGuard(new Flag(true), 'sync');
    expect(wrapInstance(guard)).toBe(true);
    const wrapped = guard.canActivate;
    expect(wrapInstance(guard)).toBe(false);
    expect(guard.canActivate).toBe(wrapped);
    expect(isWrapped(guard)).toBe(true);
    expect(Object.keys(guard)).not.toContain('canActivate');

    const frozen = Object.freeze(new FlagGuard(new Flag(true), 'sync'));
    expect(wrapInstance(frozen)).toBe(false);
    expect(isWrapped(frozen)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(frozen, 'canActivate')).toBe(false);
  });
});

describe('wrapEnhancers', () => {
  class InlinePipe {
    transform(value: unknown) {
      return value;
    }
  }
  const inline = new InlinePipe();
  class SomeController {
    @UsePipes(inline)
    handler() {
      return 'ok';
    }
  }
  class TransientPipe {
    transform(value: unknown) {
      return value;
    }
  }
  class ScopedGuard {
    canActivate() {
      return true;
    }
  }

  it('wraps static injectables, inline instances and globals, and reports scoped ones', () => {
    const staticGuard = new FlagGuard(new Flag(true), 'sync');
    const skipped = { intercept: () => of(1) };
    const globalFilter = { catch: () => undefined };
    const transientPipe = new TransientPipe();
    const wrapper = (instance: unknown, extra: Partial<InstanceWrapperLike> = {}) => ({
      instance,
      metatype: (instance as object | undefined)?.constructor,
      isDependencyTreeStatic: () => true,
      ...extra,
    });
    const container = [
      {
        injectables: new Map<unknown, InstanceWrapperLike>([
          ['a', wrapper(staticGuard)],
          ['b', wrapper(undefined, { metatype: ScopedGuard, isDependencyTreeStatic: () => false })],
          ['c', wrapper(skipped)],
          // A transient one has a placeholder instance Nest never runs: not wrapped, reported.
          ['e', wrapper(transientPipe, { isTransient: true })],
        ]),
        controllers: new Map<unknown, InstanceWrapperLike>([['d', wrapper(new SomeController())]]),
      },
    ];
    const config = {
      getGlobalFilters: () => [globalFilter],
      getGlobalRequestInterceptors: () => [{ metatype: class RequestScopedThing {} }],
    };

    const report = wrapEnhancers(container, config, (instance) => instance === skipped);
    expect(report.wrapped).toBe(3);
    expect([...report.untraced].sort()).toEqual([
      'RequestScopedThing',
      'ScopedGuard',
      'TransientPipe',
    ]);
    expect(isWrapped(transientPipe)).toBe(false);
    expect(isWrapped(staticGuard)).toBe(true);
    expect(isWrapped(inline)).toBe(true);
    expect(isWrapped(globalFilter)).toBe(true);
    expect(isWrapped(skipped)).toBe(false);
    expect((skipped as Record<symbol, unknown>)[WRAPPED]).toBeUndefined();

    // A second walk finds everything marked.
    expect(wrapEnhancers(container, config).wrapped).toBe(1);
  });
});

describe('everyRoute', () => {
  it('names the wildcard in the syntax of each Nest major', () => {
    expect(everyRoute('11.1.0')).toBe('{*path}');
    expect(everyRoute('10.4.15')).toBe('*');
    expect(everyRoute('unknown')).toBe('{*path}');
  });
});
