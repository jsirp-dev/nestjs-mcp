import type { LastRun } from '../runs/model.js';

/** One `@OnEvent` listener as `events_listeners` answers it. */
export interface EventListenerModel {
  /** The pattern as declared; an array is eventemitter2's segment form. Symbols by description. */
  event: string | string[];
  className: string;
  methodName: string;
  /** The module declaring the class, by graph name (by class name without a snapshot). */
  module: string;
  /** The decorator's options (`async`, `prependListener`, …), when it was given any. */
  options?: Record<string, unknown>;
  /** The class has no long-lived instance; Nest creates one per emission. */
  requestScoped?: true;
  /** With the `runs` group on: the latest run recorded of this listener (never request-scoped). */
  lastRun?: LastRun;
}

/** One `emit`/`emitAsync` call as the ring buffer keeps it. Never the payload. */
export interface EmissionRecord {
  /** The event name; an array is joined with the emitter's delimiter. */
  event: string;
  method: 'emit' | 'emitAsync';
  timestamp: string;
  /** `emitter.listenerCount(event)` when it was emitted: wildcard listeners included. */
  listeners: number;
}
