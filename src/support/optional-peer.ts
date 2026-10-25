import { createRequire } from 'node:module';

/**
 * Loads an optional peer the way the app resolves it, or `null` when it is not installed. Its
 * tool group is then not registered. `__filename` is native in the CJS build and shimmed by tsup
 * in the ESM build.
 */
export function tryRequire<T = unknown>(name: string): T | null {
  try {
    return createRequire(__filename)(name) as T;
  } catch {
    return null;
  }
}
