import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunRecord } from './model.js';

/** The emission a listener is called in: its event as text. Never its payload. */
export interface Emission {
  event: string;
}

const runs = new AsyncLocalStorage<RunRecord>();
const emissions = new AsyncLocalStorage<Emission>();

/** The run whose method is executing in this async context, the innermost one when nested. */
export function currentRun(): RunRecord | undefined {
  return runs.getStore();
}

export function runWithRun<T>(run: RunRecord, fn: () => T): T {
  return runs.run(run, fn);
}

/** The emission whose listeners are running in this async context, if any. */
export function currentEmission(): Emission | undefined {
  return emissions.getStore();
}

export function runInEmission<T>(emission: Emission, fn: () => T): T {
  return emissions.run(emission, fn);
}
