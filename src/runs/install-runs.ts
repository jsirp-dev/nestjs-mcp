import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { eventText, type EmitterLike } from '../events/emit-recorder.js';
import { findEmitter, matcher } from '../events/install-events.js';
import {
  EVENT_LISTENER_METADATA,
  isRequestScoped,
  listenerPattern,
} from '../events/listeners-reader.js';
import { current, describeError, round } from '../requests/trace-context.js';
import { findRegistry } from '../schedule/install-schedule.js';
import {
  SCHEDULE_CRON_OPTIONS,
  SCHEDULE_INTERVAL_OPTIONS,
  SCHEDULE_TIMEOUT_OPTIONS,
  SCHEDULER_NAME,
} from '../schedule/jobs-reader.js';
import { classNameOf, getMetadata, methods, prototypeOf } from '../support/class-methods.js';
import {
  forEachInstance,
  type ContainerLike,
  type ContainerModuleLike,
} from '../support/for-each-instance.js';
import { tryRequire } from '../support/optional-peer.js';
import { RingBuffer } from '../support/ring-buffer.js';
import type { RunKind, RunRecord } from './model.js';
import { currentEmission, runInEmission, runWithRun } from './run-context.js';

/** A run as the buffer keeps it: the record and the container module declaring its class. */
export interface RunEntry {
  run: RunRecord;
  module: ContainerModuleLike;
}

/** What the runs tools read: the app's runs, and how the app's emitter matches events. */
export interface RunsInspector {
  buffer: RingBuffer<RunEntry>;
  /** Whether the emitter calls a listener of `pattern` for `event`; absent without an emitter. */
  matches?(pattern: string | string[], event: string): boolean;
  /** The emitter's delimiter, to read an array pattern as text. */
  delimiter: string;
  /**
   * Takes back the job wrappers once the scheduler holds them (at `onApplicationBootstrap`), so a
   * call the app makes to the method itself is not a run. Listener wrappers stay.
   */
  settle(): void;
}

/** The mark on a wrapper function, and on an emitter that opens emission contexts. */
const WRAPPED = Symbol('nestjs-mcp.run-wrapper');
const EMISSIONS = Symbol('nestjs-mcp.emission-context');

/** Once per app: every instance of the inspector reads the same runs. */
const installed = new WeakMap<ContainerLike, RunsInspector>();

/** Patterns matched per event, at most this many kept. */
const MATCH_CACHE = 1000;

type Method = (this: unknown, ...args: unknown[]) => unknown;

function isWrapped(method: object): boolean {
  return (method as Record<symbol, unknown>)[WRAPPED] === true;
}

interface DeclaredJob {
  kind: Exclude<RunKind, 'listener'>;
  name?: string;
}

function jobOf(method: object): DeclaredJob | undefined {
  const cron = getMetadata(SCHEDULE_CRON_OPTIONS, method) as { name?: unknown } | undefined;
  const kind = cron
    ? 'cron'
    : getMetadata(SCHEDULE_INTERVAL_OPTIONS, method)
      ? 'interval'
      : getMetadata(SCHEDULE_TIMEOUT_OPTIONS, method)
        ? 'timeout'
        : undefined;
  if (!kind) return undefined;
  const name = getMetadata(SCHEDULER_NAME, method) ?? cron?.name;
  return typeof name === 'string' && name ? { kind, name } : { kind };
}

function patternsOf(method: object): Array<string | string[]> | undefined {
  const raw = getMetadata(EVENT_LISTENER_METADATA, method);
  if (!raw) return undefined;
  const declared = (Array.isArray(raw) ? raw : [raw]) as Array<{ event?: unknown }>;
  return declared.map(({ event }) => listenerPattern(event));
}

/** Gives `to` every metadata entry of `from`: both peers read the decorators off the function. */
function copyMetadata(from: object, to: object): void {
  const reflect = Reflect as unknown as {
    getMetadataKeys?(target: object): unknown[];
    getMetadata?(key: unknown, target: object): unknown;
    defineMetadata?(key: unknown, value: unknown, target: object): void;
  };
  for (const key of reflect.getMetadataKeys?.(from) ?? []) {
    reflect.defineMetadata?.(key, reflect.getMetadata?.(key, from), to);
  }
}

function cachedMatcher(emitter: EmitterLike): NonNullable<RunsInspector['matches']> {
  const ask = matcher(emitter);
  const cache = new Map<string, boolean>();
  return (pattern, event) => {
    const key = JSON.stringify([pattern, event]);
    let hit = cache.get(key);
    if (hit === undefined) {
      if (cache.size >= MATCH_CACHE) cache.clear();
      hit = ask(pattern, event);
      cache.set(key, hit);
    }
    return hit;
  };
}

/**
 * Wraps `emit` and `emitAsync` on the emitter, once, only to run each call inside an emission
 * context holding its event: the listener wrappers read it to know they were called by the
 * emitter, and for which event. Same `this`, arguments, return value and throw.
 */
function openEmissions(emitter: EmitterLike): void {
  const marked = emitter as unknown as Record<symbol, unknown>;
  if (marked[EMISSIONS]) return;
  for (const method of ['emit', 'emitAsync'] as const) {
    const original = emitter[method] as Method;
    Object.defineProperty(emitter, method, {
      configurable: true,
      writable: true,
      value: function emitInContext(this: unknown, ...args: unknown[]) {
        const emission = { event: eventText(args[0], emitter.delimiter) };
        return runInEmission(emission, () => original.apply(this, args));
      },
    });
  }
  Object.defineProperty(emitter, EMISSIONS, { value: true });
}

/**
 * Wraps the methods behind the decorated jobs (when `@nestjs/schedule` is installed and the app
 * imports its module) and behind the `@OnEvent` listeners (likewise for `@nestjs/event-emitter`)
 * of every long-lived provider and controller, as ADR-0006 describes. Must run before any
 * `onModuleInit`: the scheduler reads the methods there. `undefined` when neither peer is present.
 */
export function installRuns(
  container: ContainerLike,
  bufferSize: number,
): RunsInspector | undefined {
  const existing = installed.get(container);
  if (existing) return existing;
  const schedule = tryRequire<{ SchedulerRegistry?: unknown }>('@nestjs/schedule');
  const events = tryRequire<{ EventEmitter2?: unknown }>('@nestjs/event-emitter');
  const registry = schedule ? findRegistry(container, schedule.SchedulerRegistry) : undefined;
  const emitter = events ? findEmitter(container, events.EventEmitter2) : undefined;
  if (!registry && !emitter) return undefined;

  const buffer = new RingBuffer<RunEntry>(bufferSize);
  const matches = emitter ? cachedMatcher(emitter) : undefined;
  if (emitter) openEmissions(emitter);
  const settlers: Array<() => void> = [];

  forEachInstance(container, ['providers', 'controllers'], (wrapper, module) => {
    const { instance } = wrapper;
    if (typeof instance !== 'object' || instance === null || isRequestScoped(wrapper)) return;
    const prototype = prototypeOf(wrapper);
    if (!prototype) return;
    const className = classNameOf(prototype);
    for (const [methodName, method] of methods(prototype)) {
      const job = registry ? jobOf(method) : undefined;
      const patterns = emitter ? patternsOf(method) : undefined;
      if (!job && !patterns) continue;
      const own = Object.getOwnPropertyDescriptor(instance, methodName);
      const original = (own ? own.value : method) as unknown;
      if (typeof original !== 'function' || isWrapped(original)) continue;

      /** A listener run when the emitter called the method for an event it listens to. */
      const listening = (): Pick<RunRecord, 'kind' | 'event'> | undefined => {
        const emission = currentEmission();
        if (!emission || !patterns || !matches) return undefined;
        if (!patterns.some((pattern) => matches(pattern, emission.event))) return undefined;
        return { kind: 'listener', event: emission.event };
      };
      const record = (
        fields: Pick<RunRecord, 'kind' | 'name' | 'event'>,
        self: unknown,
        args: unknown[],
      ): unknown => {
        const run: RunRecord = {
          id: randomUUID(),
          kind: fields.kind,
          className,
          methodName,
          ...(fields.name !== undefined ? { name: fields.name } : {}),
          ...(fields.event !== undefined ? { event: fields.event } : {}),
          startedAt: new Date().toISOString(),
          outcome: 'running',
        };
        const trace = current();
        if (trace) run.requestId = trace.trace.id;
        buffer.push({ run, module });
        const t0 = performance.now();
        const finish = (threw: boolean, error?: unknown) => {
          run.durationMs = round(performance.now() - t0);
          run.outcome = threw ? 'threw' : 'ok';
          if (threw) run.error = describeError(error);
        };
        let result: unknown;
        try {
          result = runWithRun(run, () => (original as Method).apply(self, args));
        } catch (error) {
          finish(true, error);
          throw error;
        }
        // Only a native promise is observed: `then` on another thenable may start work again.
        if (result instanceof Promise) {
          result.then(
            () => finish(false),
            (error: unknown) => finish(true, error),
          );
        } else {
          finish(false);
        }
        return result;
      };
      const wrap = (decide: () => Pick<RunRecord, 'kind' | 'name' | 'event'> | undefined) => {
        const wrapped = function recordRun(this: unknown, ...args: unknown[]) {
          const fields = decide();
          return fields ? record(fields, this, args) : (original as Method).apply(this, args);
        };
        copyMetadata(original as object, wrapped);
        Object.defineProperty(wrapped, 'name', { value: (original as Method).name });
        Object.defineProperty(wrapped, WRAPPED, { value: true });
        return wrapped;
      };
      const listener = patterns ? wrap(listening) : undefined;
      const scheduled = job ? wrap(() => listening() ?? job) : undefined;
      const define = (value: unknown) =>
        Object.defineProperty(instance, methodName, {
          configurable: true,
          writable: true,
          enumerable: own?.enumerable ?? false,
          value,
        });
      try {
        define(scheduled ?? listener);
      } catch {
        continue;
      }
      if (!scheduled) continue;
      settlers.push(() => {
        try {
          if (listener) define(listener);
          else if (own) Object.defineProperty(instance, methodName, own);
          else delete (instance as Record<string, unknown>)[methodName];
        } catch {
          // The app froze or redefined it since: leave it as it is.
        }
      });
    }
  });

  let settled = false;
  const inspector: RunsInspector = {
    buffer,
    ...(matches ? { matches } : {}),
    delimiter: emitter?.delimiter ?? '.',
    settle() {
      if (settled) return;
      settled = true;
      for (const settle of settlers) settle();
    },
  };
  installed.set(container, inspector);
  return inspector;
}
