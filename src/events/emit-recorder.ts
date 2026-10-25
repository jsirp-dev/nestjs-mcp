import type { RingBuffer } from '../support/ring-buffer.js';
import type { EmissionRecord } from './model.js';

/** What the recorder reads from an `EventEmitter2`. Duck-typed on purpose. */
export interface EmitterLike {
  emit(event: unknown, ...values: unknown[]): unknown;
  emitAsync(event: unknown, ...values: unknown[]): unknown;
  listenerCount(event?: unknown): number;
  listeners?(event?: unknown): unknown[];
  wildcard?: boolean;
  delimiter?: string;
}

/** The mark on a wrapped emitter, holding its buffer; shared by every copy of the package. */
export const EMIT_RECORDER = Symbol.for('nestjs-mcp.emit-recorder');

const METHODS = ['emit', 'emitAsync'] as const;

/** An event name as text: segments joined with the emitter's delimiter, symbols by description. */
export function eventText(event: unknown, delimiter = '.'): string {
  if (Array.isArray(event)) return event.map((segment) => eventText(segment)).join(delimiter);
  if (typeof event === 'symbol') return event.description ?? event.toString();
  return String(event);
}

function count(emitter: EmitterLike, event: unknown): number {
  try {
    return emitter.listenerCount(event);
  } catch {
    return 0;
  }
}

/**
 * Wraps `emit` and `emitAsync` on the emitter itself, once: each call pushes the event name, the
 * method, the time and the listener count, then calls the original with the same `this` and
 * arguments and returns what it returned (the boolean, the very same promise) or throws what it
 * threw. The payload is never read. A second install returns the buffer of the first.
 */
export function installEmitRecorder(
  emitter: EmitterLike,
  buffer: RingBuffer<EmissionRecord>,
): RingBuffer<EmissionRecord> {
  const marked = (emitter as unknown as Record<symbol, RingBuffer<EmissionRecord> | undefined>)[
    EMIT_RECORDER
  ];
  if (marked) return marked;

  for (const method of METHODS) {
    const original = emitter[method] as (this: unknown, ...args: unknown[]) => unknown;
    Object.defineProperty(emitter, method, {
      configurable: true,
      writable: true,
      value: function recordEmission(this: unknown, ...args: unknown[]) {
        const event = args[0];
        buffer.push({
          event: eventText(event, emitter.delimiter),
          method,
          timestamp: new Date().toISOString(),
          listeners: count(emitter, event),
        });
        // `apply` with the arguments as given: eventemitter2 reads `arguments.length`.
        return original.apply(this, args);
      },
    });
  }
  Object.defineProperty(emitter, EMIT_RECORDER, { value: buffer });
  return buffer;
}
