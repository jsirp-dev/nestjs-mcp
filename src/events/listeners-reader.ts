import {
  forEachInstance,
  type ContainerLike,
  type ContainerModuleLike,
  type InstanceWrapperLike,
} from '../support/for-each-instance.js';
import { classNameOf, getMetadata, methods, prototypeOf } from '../support/class-methods.js';
import { eventText } from './emit-recorder.js';
import type { EventListenerModel } from './model.js';

/**
 * The key `@OnEvent` stores its `{ event, options }` under, on the method itself. Not exported
 * from the package's entry (only from `dist/constants`), and the same string in versions 1 to 3.
 */
export const EVENT_LISTENER_METADATA = 'EVENT_LISTENER_METADATA';

interface ListenerMetadata {
  event?: unknown;
  options?: unknown;
}

/** A declared `@OnEvent` event as text; an array is eventemitter2's segment form. */
export function listenerPattern(event: unknown): string | string[] {
  return Array.isArray(event) ? event.map((segment) => eventText(segment)) : eventText(event);
}

export function isRequestScoped(wrapper: InstanceWrapperLike): boolean {
  try {
    return wrapper.isDependencyTreeStatic?.() === false;
  } catch {
    return false;
  }
}

/**
 * Every `@OnEvent` listener of the providers and controllers in the container, read from the
 * decorator's metadata on each prototype. Nothing of the app is called, and classes without a
 * long-lived instance (`REQUEST` scope) are listed too: their metadata lives on the prototype.
 */
export function readListeners(
  container: ContainerLike,
  moduleName: (module: ContainerModuleLike) => string,
): EventListenerModel[] {
  const listeners: EventListenerModel[] = [];
  const seen = new Set<string>();
  forEachInstance(container, ['providers', 'controllers'], (wrapper, module) => {
    const prototype = prototypeOf(wrapper);
    if (!prototype) return;
    const className = classNameOf(prototype);
    for (const [methodName, method] of methods(prototype)) {
      const raw = getMetadata(EVENT_LISTENER_METADATA, method);
      if (!raw) continue;
      const declared = (Array.isArray(raw) ? raw : [raw]) as ListenerMetadata[];
      const owner = moduleName(module);
      for (const { event, options } of declared) {
        const listener: EventListenerModel = {
          event: listenerPattern(event),
          className,
          methodName,
          module: owner,
        };
        if (options && typeof options === 'object' && Object.keys(options).length > 0) {
          listener.options = { ...(options as Record<string, unknown>) };
        }
        if (isRequestScoped(wrapper)) listener.requestScoped = true;
        // One class provided twice under two tokens in one module is one listener.
        const key = JSON.stringify([owner, className, methodName, listener.event]);
        if (seen.has(key)) continue;
        seen.add(key);
        listeners.push(listener);
      }
    }
  });
  return listeners;
}
