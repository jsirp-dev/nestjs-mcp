import { forEachInstance, type ContainerLike } from '../support/for-each-instance.js';
import { tryRequire } from '../support/optional-peer.js';
import type { SchedulerRegistryLike } from './jobs-reader.js';

/** What the schedule tools read: the app's registry, and the container for the decorated jobs. */
export interface ScheduleInspector {
  /** Walked per call: the registry changes at runtime, the decorated methods do not. */
  container: ContainerLike;
  registry: SchedulerRegistryLike;
}

function isRegistry(value: unknown): value is SchedulerRegistryLike {
  const candidate = value as Partial<Record<keyof SchedulerRegistryLike, unknown>> | null;
  return (
    typeof candidate?.getCronJobs === 'function' &&
    typeof candidate.getIntervals === 'function' &&
    typeof candidate.getTimeouts === 'function' &&
    typeof candidate.getInterval === 'function' &&
    typeof candidate.getTimeout === 'function'
  );
}

/**
 * The registry `ScheduleModule` provides: the provider whose token is the package's
 * `SchedulerRegistry`, or, when the app resolves another copy of it, a class token of that name.
 */
function findRegistry(
  container: ContainerLike,
  peerClass: unknown,
): SchedulerRegistryLike | undefined {
  let byClass: SchedulerRegistryLike | undefined;
  let byName: SchedulerRegistryLike | undefined;
  forEachInstance(container, ['providers'], (wrapper) => {
    if (!isRegistry(wrapper.instance)) return;
    if (peerClass !== undefined && wrapper.token === peerClass) byClass ??= wrapper.instance;
    else if (typeof wrapper.token === 'function' && wrapper.token.name === 'SchedulerRegistry') {
      byName ??= wrapper.instance;
    }
  });
  return byClass ?? byName;
}

/**
 * Finds the app's `SchedulerRegistry`. Nothing is wrapped: the registry is read per call.
 * `undefined` when `@nestjs/schedule` is not installed or the app does not import its module: the
 * schedule group is then not registered.
 */
export function installSchedule(container: ContainerLike): ScheduleInspector | undefined {
  const peer = tryRequire<{ SchedulerRegistry?: unknown }>('@nestjs/schedule');
  if (!peer) return undefined;
  const registry = findRegistry(container, peer.SchedulerRegistry);
  return registry ? { container, registry } : undefined;
}
