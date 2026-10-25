import { methods } from './class-methods.js';

/** Per controller class, the key found for each handler function (`undefined`: none). */
const keys = new WeakMap<object, Map<unknown, string | undefined>>();

/**
 * The property key under which a controller's prototype chain holds `handler`: the name Nest
 * registered the route by, and the one `routes_list` shows. A decorator that replaces the method
 * leaves a wrapper whose `name` is `''` or its own, so the function's name is not enough. When the
 * same function sits under several keys, its own name wins if it is one of them. Cached per class,
 * since a base class's handler is one function for every controller that inherits it.
 */
export function handlerKey(controller: unknown, handler: unknown): string | undefined {
  if (typeof controller !== 'function' || typeof handler !== 'function') return undefined;
  let known = keys.get(controller);
  if (!known) keys.set(controller, (known = new Map()));
  if (known.has(handler)) return known.get(handler);
  const prototype = (controller as { prototype?: unknown }).prototype;
  const matching =
    typeof prototype === 'object' && prototype !== null
      ? methods(prototype)
          .filter(([, value]) => value === handler)
          .map(([key]) => key)
      : [];
  const key = matching.includes(handler.name) ? handler.name : matching[0];
  known.set(handler, key);
  return key;
}
