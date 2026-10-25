import type { ContainerModuleLike } from '../support/for-each-instance.js';
import type { RunEntry, RunsInspector } from './install-runs.js';
import type { LastRun, RunKind, RunModel, RunRecord } from './model.js';

/** A run with its module, in the documented field order whatever was filled in last. */
export function presentRun(entry: RunEntry, moduleName: (module: ContainerModuleLike) => string) {
  const { run } = entry;
  const model: RunModel = {
    id: run.id,
    kind: run.kind,
    className: run.className,
    methodName: run.methodName,
    module: moduleName(entry.module),
    ...(run.name !== undefined ? { name: run.name } : {}),
    ...(run.event !== undefined ? { event: run.event } : {}),
    startedAt: run.startedAt,
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    outcome: run.outcome,
    ...(run.error !== undefined ? { error: { ...run.error } } : {}),
    ...(run.requestId !== undefined ? { requestId: run.requestId } : {}),
  };
  return model;
}

function lastOf(run: RunRecord): LastRun {
  return {
    id: run.id,
    startedAt: run.startedAt,
    outcome: run.outcome,
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
  };
}

/** What identifies the method a job or listener runs: its class, method and module. */
export interface RunTarget {
  kinds: readonly RunKind[];
  className?: string;
  methodName?: string;
  module?: string;
  /** Listeners: only runs of events this pattern matches. */
  event?: string | string[];
}

/**
 * The latest run the buffer holds of the method `target` names; `undefined` when it holds none
 * (or the job has no declaring class, as the app's own registry entries).
 */
export function lastRunOf(
  runs: RunsInspector,
  moduleName: (module: ContainerModuleLike) => string,
  target: RunTarget,
): LastRun | undefined {
  if (target.className === undefined || target.methodName === undefined) return undefined;
  const held = runs.buffer.all();
  for (let index = held.length - 1; index >= 0; index -= 1) {
    const entry = held[index]!;
    const { run } = entry;
    if (!target.kinds.includes(run.kind)) continue;
    if (run.className !== target.className || run.methodName !== target.methodName) continue;
    if (target.module !== undefined && moduleName(entry.module) !== target.module) continue;
    if (target.event !== undefined && run.event !== undefined) {
      if (!runs.matches?.(target.event, run.event)) continue;
    }
    return lastOf(run);
  }
  return undefined;
}
