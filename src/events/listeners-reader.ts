import {
  forEachInstance,
  type ContainerLike,
  type ContainerModuleLike,
  type InstanceWrapperLike,
} from '../support/for-each-instance.js';
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

function getMetadata(target: object): unknown {
  const reflect = Reflect as unknown as { getMetadata?(key: string, target: object): unknown };
  return reflect.getMetadata?.(EVENT_LISTENER_METADATA, target);
}

/** The prototype Nest's subscriber loader scans: the instance's, else the class's. */
function prototypeOf(wrapper: InstanceWrapperLike): object | undefined {
  const { instance, metatype } = wrapper;
  if (typeof instance === 'object' && instance !== null) {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (prototype && prototype !== Object.prototype) return prototype;
  }
  const prototype = (metatype as { prototype?: unknown } | null | undefined)?.prototype;
  return typeof prototype === 'object' && prototype !== null ? prototype : undefined;
}

/** Method names up the chain, read through descriptors so no getter of the app runs. */
function methods(prototype: object): Array<[string, object]> {
  const found = new Map<string, object>();
  for (
    let current: object | null = prototype;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor' || found.has(name)) continue;
      const value = Object.getOwnPropertyDescriptor(current, name)?.value as unknown;
      if (typeof value === 'function') found.set(name, value);
    }
  }
  return [...found];
}

function pattern(event: unknown): string | string[] {
  return Array.isArray(event) ? event.map((segment) => eventText(segment)) : eventText(event);
}

function isRequestScoped(wrapper: InstanceWrapperLike): boolean {
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
    const className =
      (prototype as { constructor?: { name?: string } }).constructor?.name || 'anonymous';
    for (const [methodName, method] of methods(prototype)) {
      const raw = getMetadata(method);
      if (!raw) continue;
      const declared = (Array.isArray(raw) ? raw : [raw]) as ListenerMetadata[];
      const owner = moduleName(module);
      for (const { event, options } of declared) {
        const listener: EventListenerModel = {
          event: pattern(event),
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
