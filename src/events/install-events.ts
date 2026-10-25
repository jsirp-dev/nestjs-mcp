import { tryRequire } from '../support/optional-peer.js';
import { forEachInstance, type ContainerLike } from '../support/for-each-instance.js';
import { RingBuffer } from '../support/ring-buffer.js';
import { installEmitRecorder, type EmitterLike } from './emit-recorder.js';
import type { EmissionRecord } from './model.js';

/** What the events tools read: the app's emitter and the emissions recorded on it. */
export interface EventsInspector {
  /** Walked per call for the listeners: classes and metadata do not change after bootstrap. */
  container: ContainerLike;
  emitter: EmitterLike;
  emissions: RingBuffer<EmissionRecord>;
  /** Whether the emitter resolves `event` to a listener registered with `pattern`. */
  matches(pattern: string | string[], event: string): boolean;
}

function isEmitter(value: unknown): value is EmitterLike {
  const candidate = value as Partial<Record<keyof EmitterLike, unknown>> | null;
  return (
    typeof candidate?.emit === 'function' &&
    typeof candidate.emitAsync === 'function' &&
    typeof candidate.listenerCount === 'function'
  );
}

/**
 * The emitter `EventEmitterModule` provides: the provider whose token is the package's
 * `EventEmitter2`, or, when the app resolves another copy of it, a class token of that name.
 */
function findEmitter(container: ContainerLike, peerClass: unknown): EmitterLike | undefined {
  let byClass: EmitterLike | undefined;
  let byName: EmitterLike | undefined;
  forEachInstance(container, ['providers'], (wrapper) => {
    if (!isEmitter(wrapper.instance)) return;
    if (peerClass !== undefined && wrapper.token === peerClass) byClass ??= wrapper.instance;
    else if (typeof wrapper.token === 'function' && wrapper.token.name === 'EventEmitter2') {
      byName ??= wrapper.instance;
    }
  });
  return byClass ?? byName;
}

/**
 * A matcher that asks the emitter's own class: a fresh emitter with the same `wildcard` and
 * `delimiter` gets one listener on the pattern, and `listenerCount(event)` says whether it fires.
 * Falls back to equality when the class cannot be built that way.
 */
function matcher(emitter: EmitterLike): EventsInspector['matches'] {
  type Probe = EmitterLike & { on(event: unknown, listener: () => void): unknown };
  const Emitter = (emitter as { constructor?: unknown }).constructor as
    (new (options: object) => Probe) | undefined;
  return (pattern, event) => {
    try {
      const probe = new Emitter!({ wildcard: emitter.wildcard, delimiter: emitter.delimiter });
      probe.on(pattern, () => undefined);
      return probe.listenerCount(event) > 0;
    } catch {
      const text = Array.isArray(pattern) ? pattern.join(emitter.delimiter ?? '.') : pattern;
      return text === event;
    }
  };
}

/**
 * Finds the app's `EventEmitter2` and wraps its `emit`/`emitAsync` (once per emitter, so every
 * instance of the inspector shares the buffer). `undefined` when `@nestjs/event-emitter` is not
 * installed or the app does not import its module: the events group is then not registered.
 */
export function installEvents(
  container: ContainerLike,
  bufferSize: number,
): EventsInspector | undefined {
  const peer = tryRequire<{ EventEmitter2?: unknown }>('@nestjs/event-emitter');
  if (!peer) return undefined;
  const emitter = findEmitter(container, peer.EventEmitter2);
  if (!emitter) return undefined;
  return {
    container,
    emitter,
    emissions: installEmitRecorder(emitter, new RingBuffer<EmissionRecord>(bufferSize)),
    matches: matcher(emitter),
  };
}
