import type { InstanceWrapperLike } from './for-each-instance.js';

/** The prototype Nest's explorers scan: the instance's, else the class's. */
export function prototypeOf(wrapper: InstanceWrapperLike): object | undefined {
  const { instance, metatype } = wrapper;
  if (typeof instance === 'object' && instance !== null) {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (prototype && prototype !== Object.prototype) return prototype;
  }
  const prototype = (metatype as { prototype?: unknown } | null | undefined)?.prototype;
  return typeof prototype === 'object' && prototype !== null ? prototype : undefined;
}

/** The name of the class a prototype belongs to. */
export function classNameOf(prototype: object): string {
  return (prototype as { constructor?: { name?: string } }).constructor?.name || 'anonymous';
}

/** Method names up the chain, read through descriptors so no getter of the app runs. */
export function methods(prototype: object): Array<[string, object]> {
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

/** `Reflect.getMetadata` when `reflect-metadata` is loaded; `undefined` otherwise. */
export function getMetadata(key: string, target: object): unknown {
  const reflect = Reflect as unknown as { getMetadata?(key: string, target: object): unknown };
  return reflect.getMetadata?.(key, target);
}
