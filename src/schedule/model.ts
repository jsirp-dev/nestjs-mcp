export type ScheduledJobKind = 'cron' | 'interval' | 'timeout';

/** One job of `SchedulerRegistry` as `schedule_jobs` answers it. */
export interface ScheduledJobModel {
  kind: ScheduledJobKind;
  /** The registry's key: the decorator's name, a generated id when it had none, or the app's. */
  name: string;
  /** The decorated method's class and module; absent for a job the app added to the registry. */
  className?: string;
  methodName?: string;
  /** By graph name (by class name without a snapshot). */
  module?: string;
  /** Cron: the expression as given (a date as ISO), and its time zone when it was given one. */
  expression?: string;
  timeZone?: string;
  /** Interval: the period. */
  everyMs?: number;
  /** Timeout: the delay. */
  delayMs?: number;
  /** Cron: started and not stopped. Interval and timeout: not cleared, and a timeout not fired. */
  running?: boolean;
  /** Cron: when it last fired, when known. */
  lastRun?: string;
  /** Cron: when it fires next, only while it is running. */
  nextRun?: string;
}
