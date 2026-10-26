import { performance } from 'node:perf_hooks';
import { tap, type Observable, type Subscriber } from 'rxjs';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
  ROUTE_ARGS_METADATA,
} from '../constants.js';
import { argumentName, argumentOf } from '../routes/route-arguments.js';
import type { TraceStep, TraceStepOutcome } from './model.js';
import {
  current,
  describeError,
  elapsed,
  enterTrace,
  identify,
  record,
  round,
  withTrace,
  type ActiveTrace,
} from './trace-context.js';

/** The mark every wrapped instance carries, shared by every copy of the package in a process. */
export const WRAPPED = Symbol.for('nestjs-mcp.wrapped');

type EnhancerKind = 'guard' | 'interceptor' | 'pipe' | 'filter';

const METHOD: Record<EnhancerKind, string> = {
  guard: 'canActivate',
  interceptor: 'intercept',
  pipe: 'transform',
  filter: 'catch',
};

const KINDS = Object.keys(METHOD) as EnhancerKind[];

/** What the walk reads from one of Nest's `InstanceWrapper`s. Duck-typed on purpose. */
export interface InstanceWrapperLike {
  instance?: unknown;
  metatype?: unknown;
  isTransient?: boolean;
  isDependencyTreeStatic?(): boolean;
}

/** What the walk reads from one of Nest's `Module`s. */
export interface ModuleLike {
  injectables?: Map<unknown, InstanceWrapperLike>;
  controllers?: Map<unknown, InstanceWrapperLike>;
}

/** What the walk reads from Nest's `ModulesContainer`. */
export interface ModulesContainerLike {
  values(): Iterable<ModuleLike>;
}

/** The global enhancer getters of Nest's `ApplicationConfig`, looked up by name. */
export type GlobalEnhancersLike = object;

export interface WrapReport {
  /** Instances wrapped by this call (already-marked ones are not counted). */
  wrapped: number;
  /** Enhancer classes with no long-lived instance (`REQUEST`, `TRANSIENT`), which are not traced. */
  untraced: Set<string>;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

function isObservable(value: unknown): value is Observable<unknown> {
  const candidate = value as { subscribe?: unknown; pipe?: unknown } | null;
  return typeof candidate?.subscribe === 'function' && typeof candidate.pipe === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function className(value: unknown): string {
  if (typeof value === 'function') return value.name || 'anonymous';
  return (value as { constructor?: { name?: string } })?.constructor?.name || 'anonymous';
}

export function isWrapped(instance: unknown): boolean {
  return (
    typeof instance === 'object' &&
    instance !== null &&
    (instance as Record<symbol, unknown>)[WRAPPED] === true
  );
}

/** A step measured from `start` to now. */
function timed(
  active: ActiveTrace,
  start: number,
  step: Omit<TraceStep, 'startedAtMs' | 'durationMs'>,
): TraceStep {
  return {
    ...step,
    startedAtMs: elapsed(active, start),
    durationMs: round(performance.now() - start),
  };
}

/**
 * `observable` with every subscription to it made inside `active`'s async context, so what its
 * operators run when it emits (an interceptor's exit phase: its log lines, the listeners it
 * triggers) finds the trace even when the subscriber lost it: Nest's router subscribes to what the
 * interceptors return in the context the request arrived in, which a middleware such as multer
 * before 2.3 has left. The values, the error, the completion and the unsubscription are the
 * source's own; `lift` keeps the source's Observable class, as `pipe` does.
 */
function subscribedInTrace(
  active: ActiveTrace,
  observable: Observable<unknown>,
): Observable<unknown> {
  return observable.lift({
    call: (subscriber: Subscriber<unknown>, source: Observable<unknown>) =>
      enterTrace(active, () => source.subscribe(subscriber)),
  });
}

/** Calls `onValue`/`onError` when a sync value, a Promise or (optionally) an Observable settles. */
function observe(
  result: unknown,
  onValue: (value: unknown) => void,
  onError: (error: unknown) => void,
  observables: boolean,
): unknown {
  if (observables && isObservable(result)) {
    // `pipe` lifts through the source's own Observable class, so Nest's `instanceof` still holds.
    let last: unknown;
    return result.pipe(
      tap({
        next: (value) => (last = value),
        error: onError,
        complete: () => onValue(last),
      }),
    );
  }
  if (isThenable(result)) {
    return result.then(
      (value) => {
        onValue(value);
        return value;
      },
      (error: unknown) => {
        onError(error);
        throw error;
      },
    );
  }
  onValue(result);
  return result;
}

function wrapGuard(original: AnyFunction, name: string): AnyFunction {
  return function canActivate(this: unknown, ...args: unknown[]) {
    return withTrace(args[0], (active) => {
      if (!active) return original.apply(this, args);
      identify(active, args[0]);
      const start = performance.now();
      const settle = (outcome: TraceStepOutcome, error?: unknown) =>
        record(
          active,
          timed(active, start, {
            kind: 'guard',
            name,
            outcome,
            ...(error === undefined ? {} : { error: describeError(error) }),
          }),
        );
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        settle('threw', error);
        throw error;
      }
      return observe(
        result,
        (value) => settle(value ? 'allowed' : 'denied'),
        (error) => settle('threw', error),
        true,
      );
    });
  };
}

function wrapInterceptor(original: AnyFunction, name: string): AnyFunction {
  return function intercept(this: unknown, ...args: unknown[]) {
    return withTrace(args[0], (active) => {
      if (!active) return original.apply(this, args);
      identify(active, args[0]);
      const start = performance.now();
      const enter = record(active, {
        kind: 'interceptor',
        name,
        phase: 'enter',
        outcome: 'ok',
        startedAtMs: elapsed(active, start),
        durationMs: 0,
      });
      const enterFailed = (error: unknown) => {
        if (!enter) return;
        enter.outcome = 'threw';
        enter.error = describeError(error);
        enter.durationMs = round(performance.now() - start);
      };

      // Knowing whether `next.handle()` was called tells a short-circuit from a pass-through.
      let handled = false;
      const next = args[1] as { handle?: (...handleArgs: unknown[]) => unknown } | undefined;
      if (next && typeof next.handle === 'function') {
        const handle = next.handle;
        args[1] = Object.create(next, {
          handle: {
            value: (...handleArgs: unknown[]) => {
              handled = true;
              return handle.apply(next, handleArgs);
            },
            writable: true,
            configurable: true,
          },
        });
      }

      let exited = false;
      const exit = (outcome: TraceStepOutcome, error?: unknown) => {
        if (exited) return;
        exited = true;
        record(
          active,
          timed(active, start, {
            kind: 'interceptor',
            name,
            phase: 'exit',
            ...(handled ? {} : { shortCircuited: true as const }),
            outcome,
            ...(error === undefined ? {} : { error: describeError(error) }),
          }),
        );
      };
      const watch = (observable: unknown) =>
        isObservable(observable)
          ? subscribedInTrace(
              active,
              observable.pipe(
                tap({
                  next: () => exit('ok'),
                  error: (error: unknown) => exit('threw', error),
                  complete: () => exit('ok'),
                }),
              ),
            )
          : observable;

      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        enterFailed(error);
        throw error;
      }
      if (isThenable(result)) {
        return result.then(
          (observable) => {
            if (enter) enter.durationMs = round(performance.now() - start);
            return watch(observable);
          },
          (error: unknown) => {
            enterFailed(error);
            throw error;
          },
        );
      }
      if (enter) enter.durationMs = round(performance.now() - start);
      return watch(result);
    });
  };
}

/**
 * The argument a pipe runs on, named as `route_get` names it: the `data` Nest passes (`'id'`), or
 * `#<index>` for an argument without a name, found in the handler's route arguments.
 */
function paramOf(
  active: ActiveTrace,
  pipe: unknown,
  metadata: { type?: unknown; data?: unknown } | undefined,
): string | undefined {
  if (typeof metadata?.data === 'string') return metadata.data;
  if (!metadata || !active.target) return undefined;
  const argument = argumentOf(active.target.controller, active.target.handler, metadata, pipe);
  return argument ? argumentName(argument) : undefined;
}

function wrapPipe(original: AnyFunction, name: string): AnyFunction {
  return function transform(this: unknown, ...args: unknown[]) {
    const active = current();
    if (!active) return original.apply(this, args);
    const metadata = args[1] as { type?: unknown; data?: unknown } | undefined;
    const param = paramOf(active, this, metadata);
    const start = performance.now();
    const settle = (outcome: TraceStepOutcome, error?: unknown) =>
      record(
        active,
        timed(active, start, {
          kind: 'pipe',
          name,
          ...(param === undefined ? {} : { param }),
          ...(typeof metadata?.type === 'string' ? { paramType: metadata.type } : {}),
          outcome,
          ...(error === undefined ? {} : { error: describeError(error) }),
        }),
      );
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      settle('threw', error);
      throw error;
    }
    // The value is the handler's argument: never touched, so an Observable value passes as is.
    return observe(
      result,
      () => settle('ok'),
      (error) => settle('threw', error),
      false,
    );
  };
}

function wrapFilter(original: AnyFunction, name: string): AnyFunction {
  return function catchException(this: unknown, ...args: unknown[]) {
    return withTrace(args[1], (active) => {
      if (!active) return original.apply(this, args);
      const start = performance.now();
      const settle = (outcome: TraceStepOutcome, error: unknown) =>
        record(
          active,
          timed(active, start, { kind: 'filter', name, outcome, error: describeError(error) }),
        );
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        settle('threw', error);
        throw error;
      }
      return observe(
        result,
        () => settle('caught', args[0]),
        (error) => settle('threw', error),
        false,
      );
    });
  };
}

const WRAPPERS: Record<EnhancerKind, (original: AnyFunction, name: string) => AnyFunction> = {
  guard: wrapGuard,
  interceptor: wrapInterceptor,
  pipe: wrapPipe,
  filter: wrapFilter,
};

/**
 * Replaces, on the instance itself, the method of each kind it has with a recording wrapper, and
 * marks it. Returns whether it wrapped anything now; a marked or frozen instance is left as is.
 */
export function wrapInstance(instance: unknown, kinds: readonly EnhancerKind[] = KINDS): boolean {
  if (typeof instance !== 'object' || instance === null || isWrapped(instance)) return false;
  const target = instance as Record<string, unknown>;
  const name = className(instance);
  const replaced: Array<[string, PropertyDescriptor | undefined]> = [];
  try {
    for (const kind of kinds) {
      const method = METHOD[kind];
      const original = target[method];
      if (typeof original !== 'function') continue;
      const own = Object.getOwnPropertyDescriptor(target, method);
      const wrapper = WRAPPERS[kind](original as AnyFunction, name);
      Object.defineProperty(wrapper, 'name', { value: (original as AnyFunction).name });
      Object.defineProperty(target, method, {
        value: wrapper,
        writable: true,
        configurable: true,
        enumerable: own?.enumerable ?? false,
      });
      replaced.push([method, own]);
    }
    if (replaced.length === 0) return false;
    Object.defineProperty(target, WRAPPED, { value: true });
    return true;
  } catch {
    // A frozen or sealed instance: put back whatever was replaced and leave it untraced.
    for (const [method, own] of replaced) {
      if (own) Object.defineProperty(target, method, own);
      else delete target[method];
    }
    return false;
  }
}

function isEnhancerClass(metatype: unknown): boolean {
  if (typeof metatype !== 'function') return false;
  const prototype = (metatype as { prototype?: Record<string, unknown> }).prototype;
  return KINDS.some((kind) => typeof prototype?.[METHOD[kind]] === 'function');
}

/** Every method name of a class's prototype chain, below `Object.prototype`. */
function methodNames(metatype: { prototype?: object }): string[] {
  const names = new Set<string>();
  for (
    let prototype = metatype.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') names.add(name);
    }
  }
  return [...names];
}

const METADATA_KIND: Array<[string, EnhancerKind]> = [
  [GUARDS_METADATA, 'guard'],
  [INTERCEPTORS_METADATA, 'interceptor'],
  [PIPES_METADATA, 'pipe'],
  [EXCEPTION_FILTERS_METADATA, 'filter'],
];

/**
 * Enhancer instances written in a controller's decorators (`@UsePipes(new ValidationPipe())`,
 * `@Param('id', new ParseIntPipe())`): Nest uses them as they are, outside the container.
 */
function inlineInstances(controller: unknown): Array<[unknown, EnhancerKind]> {
  if (typeof controller !== 'function') return [];
  const found: Array<[unknown, EnhancerKind]> = [];
  const read = (target: object, kind: EnhancerKind, key: string, property?: string) => {
    const values = (
      property === undefined
        ? Reflect.getMetadata(key, target)
        : Reflect.getMetadata(key, target, property)
    ) as unknown;
    if (!Array.isArray(values)) return;
    for (const value of values) if (typeof value === 'object') found.push([value, kind]);
  };
  for (const [key, kind] of METADATA_KIND) read(controller, kind, key);
  const prototype = (controller as { prototype: Record<string, unknown> }).prototype;
  for (const name of methodNames(controller as { prototype?: object })) {
    const method = prototype[name];
    if (typeof method === 'function') {
      for (const [key, kind] of METADATA_KIND) read(method, kind, key);
    }
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
      string,
      { pipes?: unknown[] }
    >;
    for (const argument of Object.values(args)) {
      for (const pipe of argument.pipes ?? []) {
        if (typeof pipe === 'object') found.push([pipe, 'pipe']);
      }
    }
  }
  return found;
}

function isStatic(wrapper: InstanceWrapperLike): boolean {
  if (wrapper.isTransient === true) return false;
  return typeof wrapper.isDependencyTreeStatic === 'function'
    ? wrapper.isDependencyTreeStatic()
    : true;
}

/**
 * Wraps every enhancer instance Nest will run on an HTTP route: the `injectables` of each module
 * (what `@UseGuards(Class)` and friends instantiate), the instances written inline in controller
 * decorators, and the globals in `ApplicationConfig` (`useGlobalX` and `APP_X`). Idempotent:
 * marked instances are skipped. `skip` leaves out the inspector's own instances.
 */
export function wrapEnhancers(
  modulesContainer: ModulesContainerLike,
  applicationConfig: GlobalEnhancersLike,
  skip: (instance: unknown) => boolean = () => false,
): WrapReport {
  const report: WrapReport = { wrapped: 0, untraced: new Set() };
  const wrap = (instance: unknown, kinds?: readonly EnhancerKind[]) => {
    if (!skip(instance) && wrapInstance(instance, kinds)) report.wrapped += 1;
  };

  for (const module of modulesContainer.values()) {
    for (const wrapper of module.injectables?.values() ?? []) {
      if (!isStatic(wrapper) || wrapper.instance === undefined || wrapper.instance === null) {
        if (isEnhancerClass(wrapper.metatype)) report.untraced.add(className(wrapper.metatype));
        continue;
      }
      wrap(wrapper.instance);
    }
    for (const wrapper of module.controllers?.values() ?? []) {
      for (const [instance, kind] of inlineInstances(wrapper.metatype)) wrap(instance, [kind]);
    }
  }

  const config = applicationConfig as Record<string, unknown>;
  const read = (method: string): unknown[] => {
    const getter = config[method];
    return typeof getter === 'function' ? ((getter.call(config) as unknown[]) ?? []) : [];
  };
  for (const [plural, kind] of [
    ['Guards', 'guard'],
    ['Interceptors', 'interceptor'],
    ['Pipes', 'pipe'],
    ['Filters', 'filter'],
  ] as const) {
    for (const instance of read(`getGlobal${plural}`)) wrap(instance, [kind]);
    for (const wrapper of read(`getGlobalRequest${plural}`)) {
      report.untraced.add(className((wrapper as InstanceWrapperLike).metatype));
    }
  }
  return report;
}
