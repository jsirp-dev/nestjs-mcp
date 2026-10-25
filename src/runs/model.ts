import type { TraceError } from '../requests/model.js';

/** What ran: a job of `SchedulerRegistry`, by its decorator, or an `@OnEvent` listener. */
export type RunKind = 'cron' | 'interval' | 'timeout' | 'listener';

export const RUN_KINDS: readonly RunKind[] = ['cron', 'interval', 'timeout', 'listener'];

/** `running` until the method returns or its promise settles; then `ok` or `threw`. */
export type RunOutcome = 'running' | 'ok' | 'threw';

export const RUN_OUTCOMES: readonly RunOutcome[] = ['running', 'ok', 'threw'];

/** One execution of a job or listener method. Never the event payload or the job's arguments. */
export interface RunRecord {
  id: string;
  kind: RunKind;
  className: string;
  methodName: string;
  /** Jobs: the name the decorator gave it, when it gave one. */
  name?: string;
  /** Listeners: the event emitted, as text (segments joined with the emitter's delimiter). */
  event?: string;
  startedAt: string;
  /** Unset while it runs. */
  durationMs?: number;
  outcome: RunOutcome;
  error?: TraceError;
  /** The request traced when the run started, when it started inside one. */
  requestId?: string;
}

/** A run as the tools answer it: with the module that declares its class. */
export type RunModel = RunRecord & { module: string };

/** What `schedule_jobs` and `events_listeners` show of the latest run of a job or listener. */
export interface LastRun {
  id: string;
  startedAt: string;
  outcome: RunOutcome;
  durationMs?: number;
}
