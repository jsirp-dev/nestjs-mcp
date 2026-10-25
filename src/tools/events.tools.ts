import { z } from 'zod';
import { isGraphUnavailable } from '../graph/model.js';
import { describeScope, inScope, type AnswerScope } from '../instance/scope.js';
import type { EventsInspector } from '../events/install-events.js';
import { readListeners } from '../events/listeners-reader.js';
import type { EmissionRecord, EventListenerModel } from '../events/model.js';
import type { ContainerModuleLike } from '../support/for-each-instance.js';
import type { Sequenced } from '../support/ring-buffer.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export interface EventsListenersAnswer {
  scope: AnswerScope;
  /** Whether the emitter resolves wildcard patterns (`wildcard: true` in `forRoot`). */
  wildcard: boolean;
  listeners: EventListenerModel[];
}

export interface EventsRecentAnswer {
  scope: AnswerScope;
  /** An event has no module: every instance sees every emission of the app's emitter. */
  emissions: 'app-wide';
  /** Oldest first. */
  entries: Array<Sequenced<EmissionRecord>>;
}

/** Whether `needle` names the event: a substring of its text, or a pattern the emitter fires. */
function names(events: EventsInspector, pattern: string | string[], needle: string): boolean {
  const text = Array.isArray(pattern) ? pattern.join(events.emitter.delimiter ?? '.') : pattern;
  return text.includes(needle) || events.matches(pattern, needle);
}

export function registerEventsTools(registry: ToolRegistry, context: ToolContext): void {
  const events = (): EventsInspector => {
    if (!context.events) {
      throw new ToolError(
        'events_not_installed',
        'The emitter is looked up while the app initialises; call again once it has.',
      );
    }
    return context.events;
  };

  /** The graph name of a container module, which is what the scope holds. */
  const moduleName = (): ((module: ContainerModuleLike) => string) => {
    const model = context.graph.read();
    return (module) =>
      (!isGraphUnavailable(model) && module.id !== undefined
        ? model.modules[module.id]?.name
        : undefined) ??
      module.name ??
      'unknown';
  };

  registry.register('events', {
    name: 'events_listeners',
    description:
      'Every @OnEvent listener (@nestjs/event-emitter) of the providers and controllers in scope: ' +
      'the event pattern as declared, class, method, module and decorator options. With event, ' +
      'only listeners whose pattern contains it or that the emitter would call for it (wildcards ' +
      "and delimiter resolved by the emitter itself). scope: 'app' lifts a module scope.",
    inputSchema: {
      event: z
        .string()
        .optional()
        .describe('An event name, or a substring of the declared pattern'),
      scope: z
        .enum(['instance', 'app'])
        .optional()
        .describe("'app' lists every listener, even from a module-scoped instance"),
    },
    handler: (input): EventsListenersAnswer => {
      const typed = input as { event?: string; scope?: 'instance' | 'app' };
      const active = events();
      const instanceScope = typed.scope === 'app' ? { kind: 'app' as const } : context.scope();
      const listeners = readListeners(active.container, moduleName())
        .filter((listener) => inScope(instanceScope, listener.module))
        .filter(
          (listener) => typed.event === undefined || names(active, listener.event, typed.event),
        );
      return {
        scope: describeScope(instanceScope),
        wildcard: active.emitter.wildcard === true,
        listeners,
      };
    },
  });

  registry.register('events', {
    name: 'events_recent',
    description:
      "The latest emit/emitAsync calls on the app's EventEmitter2, oldest first: event name, " +
      'method, timestamp and how many listeners it had then (wildcard listeners included). ' +
      'Payloads are never kept. Emissions are app-wide: a module scope does not filter them. ' +
      'With event, only emissions whose name contains it or that the pattern matches.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`At most this many, the newest (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      event: z
        .string()
        .optional()
        .describe('A substring of the event name, or a pattern such as cat.* with wildcards on'),
    },
    handler: (input): EventsRecentAnswer => {
      const typed = input as { limit?: number; event?: string };
      const active = events();
      const limit = Math.min(typed.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const matching = active.emissions
        .all()
        .filter(
          (entry) =>
            typed.event === undefined ||
            entry.event.includes(typed.event) ||
            active.matches(typed.event, entry.event),
        );
      return {
        scope: describeScope(context.scope()),
        emissions: 'app-wide',
        entries: matching.slice(-limit),
      };
    },
  });
}
