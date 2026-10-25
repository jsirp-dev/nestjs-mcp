import { classNameOf, getMetadata, methods, prototypeOf } from '../support/class-methods.js';
import {
  forEachInstance,
  type ContainerLike,
  type ContainerModuleLike,
} from '../support/for-each-instance.js';
import type { ScheduledJobKind, ScheduledJobModel } from './model.js';

/**
 * The keys `@Cron`, `@Interval` and `@Timeout` store their options under, on the method itself.
 * The same strings in `@nestjs/schedule` 4 to 6. `SCHEDULER_NAME` may be missing (older
 * decorators kept the cron's name only in its options), so the kind is read from which options
 * key is present and the name from either place.
 */
export const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
export const SCHEDULE_INTERVAL_OPTIONS = 'SCHEDULE_INTERVAL_OPTIONS';
export const SCHEDULE_TIMEOUT_OPTIONS = 'SCHEDULE_TIMEOUT_OPTIONS';
export const SCHEDULER_NAME = 'SCHEDULER_NAME';

/** What the reader asks of `SchedulerRegistry`. Duck-typed on purpose. */
export interface SchedulerRegistryLike {
  getCronJobs(): Map<string, unknown>;
  getIntervals(): string[];
  getTimeouts(): string[];
  getInterval(name: string): unknown;
  getTimeout(name: string): unknown;
}

/** A job a decorator declared on a method of a class in the container. */
interface DeclaredJob {
  kind: ScheduledJobKind;
  name?: string;
  /** Cron: the expression; interval and timeout: the period, as text so both compare alike. */
  key?: string;
  timeZone?: string;
  periodMs?: number;
  className: string;
  methodName: string;
  module: string;
}

/** What one entry of the registry says about itself. */
interface RegisteredJob {
  model: ScheduledJobModel;
  key?: string;
}

/** Reads a value without letting the app's getter or method throw into the answer. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  const iso = (value as { toISO?: () => unknown } | null | undefined)?.toISO;
  if (typeof iso === 'function') {
    const text = iso.call(value) as unknown;
    if (typeof text === 'string') return text;
  }
  if (value !== null && value !== undefined && typeof value === 'object') {
    const text = String(value);
    return text === '[object Object]' ? undefined : text;
  }
  return undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readDeclared(
  container: ContainerLike,
  moduleName: (module: ContainerModuleLike) => string,
): DeclaredJob[] {
  const declared: DeclaredJob[] = [];
  const seen = new Set<string>();
  forEachInstance(container, ['providers', 'controllers'], (wrapper, module) => {
    const prototype = prototypeOf(wrapper);
    if (!prototype) return;
    const className = classNameOf(prototype);
    for (const [methodName, method] of methods(prototype)) {
      const cron = getMetadata(SCHEDULE_CRON_OPTIONS, method) as
        { cronTime?: unknown; name?: unknown; timeZone?: unknown } | undefined;
      const interval = getMetadata(SCHEDULE_INTERVAL_OPTIONS, method) as
        { timeout?: unknown } | undefined;
      const timeout = getMetadata(SCHEDULE_TIMEOUT_OPTIONS, method) as
        { timeout?: unknown } | undefined;
      if (!cron && !interval && !timeout) continue;
      const owner = moduleName(module);
      // One class provided twice under two tokens in one module is one job.
      const id = JSON.stringify([owner, className, methodName]);
      if (seen.has(id)) continue;
      seen.add(id);
      const named = getMetadata(SCHEDULER_NAME, method) ?? cron?.name;
      const base = {
        className,
        methodName,
        module: owner,
        ...(typeof named === 'string' && named ? { name: named } : {}),
      };
      if (cron) {
        const job: DeclaredJob = { ...base, kind: 'cron', key: asText(cron.cronTime) };
        if (typeof cron.timeZone === 'string') job.timeZone = cron.timeZone;
        declared.push(job);
      } else {
        const options = interval ?? timeout;
        const periodMs = positive(options?.timeout);
        declared.push({
          ...base,
          kind: interval ? 'interval' : 'timeout',
          periodMs,
          key: periodMs === undefined ? undefined : String(periodMs),
        });
      }
    }
  });
  return declared;
}

/** The process's own time zone: a cron job without one runs in it, so it is not repeated. */
function localTimeZone(): string | undefined {
  return attempt(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** A `CronJob` of `cron` 3 (`running`) or 4 (`isActive`); its next date only while running. */
function readCron(name: string, job: unknown): RegisteredJob {
  type CronJobLike = {
    isActive?: unknown;
    running?: unknown;
    cronTime?: { source?: unknown; timeZone?: unknown };
    lastDate?: () => unknown;
    nextDate?: () => unknown;
  };
  const cron = job as CronJobLike;
  const model: ScheduledJobModel = { kind: 'cron', name };
  const expression = attempt(() => asText(cron.cronTime?.source));
  if (expression !== undefined) model.expression = expression;
  const timeZone = attempt(() => cron.cronTime?.timeZone);
  if (typeof timeZone === 'string' && timeZone !== localTimeZone()) model.timeZone = timeZone;
  const active = attempt(() => cron.isActive ?? cron.running);
  if (typeof active === 'boolean') model.running = active;
  const last = attempt(() => asText(cron.lastDate?.()));
  if (last !== undefined) model.lastFiredAt = last;
  if (model.running !== false) {
    const next = attempt(() => asText(cron.nextDate?.()));
    if (next !== undefined) model.nextRun = next;
  }
  return { model, key: expression };
}

/**
 * A Node `Timeout` from `setInterval`/`setTimeout`: its period is `_idleTimeout` (-1 once
 * cleared), and `_destroyed` turns true once it is cleared or, for a timeout, once it fired.
 */
function readTimer(kind: 'interval' | 'timeout', name: string, ref: unknown): RegisteredJob {
  const timer = ref as { _idleTimeout?: unknown; _destroyed?: unknown } | null | undefined;
  const model: ScheduledJobModel = { kind, name };
  const periodMs = attempt(() => positive(timer?._idleTimeout));
  if (periodMs !== undefined) model[kind === 'interval' ? 'everyMs' : 'delayMs'] = periodMs;
  const destroyed = attempt(() => timer?._destroyed);
  if (typeof destroyed === 'boolean') model.running = !destroyed;
  return { model, key: periodMs === undefined ? undefined : String(periodMs) };
}

function readRegistered(registry: SchedulerRegistryLike): RegisteredJob[] {
  const jobs: RegisteredJob[] = [];
  for (const [name, job] of attempt(() => [...registry.getCronJobs()]) ?? []) {
    jobs.push(readCron(name, job));
  }
  for (const name of attempt(() => registry.getIntervals()) ?? []) {
    jobs.push(
      readTimer(
        'interval',
        name,
        attempt(() => registry.getInterval(name)),
      ),
    );
  }
  for (const name of attempt(() => registry.getTimeouts()) ?? []) {
    jobs.push(
      readTimer(
        'timeout',
        name,
        attempt(() => registry.getTimeout(name)),
      ),
    );
  }
  return jobs;
}

/** Adds the declaring method to a registry entry; the declared values fill what the entry lacks. */
function attach(job: ScheduledJobModel, declared: DeclaredJob): ScheduledJobModel {
  const { kind, name, ...rest } = job;
  const attached: ScheduledJobModel = {
    kind,
    name,
    className: declared.className,
    methodName: declared.methodName,
    module: declared.module,
    ...rest,
  };
  if (attached.kind === 'cron') {
    attached.expression ??= declared.key;
    if (declared.timeZone !== undefined) attached.timeZone = declared.timeZone;
  } else if (declared.periodMs !== undefined) {
    if (attached.kind === 'interval') attached.everyMs ??= declared.periodMs;
    else attached.delayMs ??= declared.periodMs;
  }
  return reorder(attached);
}

/** Keeps the documented field order whatever was filled in last. */
function reorder(job: ScheduledJobModel): ScheduledJobModel {
  const order: Array<keyof ScheduledJobModel> = [
    'kind',
    'name',
    'className',
    'methodName',
    'module',
    'expression',
    'timeZone',
    'everyMs',
    'delayMs',
    'running',
    'lastFiredAt',
    'nextRun',
  ];
  const ordered: Partial<ScheduledJobModel> = {};
  for (const field of order) {
    if (job[field] !== undefined) Object.assign(ordered, { [field]: job[field] });
  }
  return ordered as ScheduledJobModel;
}

/**
 * Every job of `SchedulerRegistry` (cron jobs, intervals, timeouts), with the class and method
 * that declared it when a decorator did. A decorated job is matched by its name; an unnamed one,
 * which the registry knows by a generated id, by its expression or period when exactly one job on
 * each side has it. Nothing of the app is called beyond the registry's getters and the jobs'
 * read-only accessors.
 */
export function readJobs(
  registry: SchedulerRegistryLike,
  container: ContainerLike,
  moduleName: (module: ContainerModuleLike) => string,
): ScheduledJobModel[] {
  const declared = readDeclared(container, moduleName);
  const registered = readRegistered(registry);
  const used = new Set<DeclaredJob>();
  const result: Array<ScheduledJobModel | undefined> = registered.map(({ model }) => {
    const match = declared.find(
      (job) => !used.has(job) && job.kind === model.kind && job.name === model.name,
    );
    if (!match) return undefined;
    used.add(match);
    return attach(model, match);
  });
  registered.forEach(({ model, key }, index) => {
    if (result[index] || key === undefined) return;
    const candidates = declared.filter(
      (job) =>
        !used.has(job) && job.name === undefined && job.kind === model.kind && job.key === key,
    );
    const rivals = registered.filter(
      (other, at) => !result[at] && other.model.kind === model.kind && other.key === key,
    );
    if (candidates.length !== 1 || rivals.length !== 1) return;
    used.add(candidates[0]!);
    result[index] = attach(model, candidates[0]!);
  });
  return result.map((job, index) => job ?? reorder(registered[index]!.model));
}
