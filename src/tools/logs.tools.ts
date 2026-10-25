import { z } from 'zod';
import { isGraphUnavailable } from '../graph/model.js';
import { describeScope, type AnswerScope, type InstanceScope } from '../instance/scope.js';
import type { LogTee } from '../logs/log-tee.js';
import { LOG_LEVELS, type LogEntry, type LogLevel } from '../logs/model.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface LogsTailInput {
  limit?: number;
  level?: LogLevel;
  minLevel?: LogLevel;
  context?: string;
  contains?: string;
  sinceSeq?: number;
  scope?: 'instance' | 'app';
}

export interface LogsTailAnswer {
  scope: AnswerScope;
  /** Present when a module scope filtered the entries by context; the filter is approximate. */
  scopeFilter?: 'context-is-class-in-scope';
  entries: LogEntry[];
  /** Pass it as `sinceSeq` in the next call to get only what came after. */
  lastSeq: number;
  /** More entries after `sinceSeq` match than `limit` allowed; call again with `lastSeq`. */
  more: boolean;
  /** Entries after `sinceSeq` the buffer already dropped, so they can no longer be read. */
  dropped?: number;
}

/**
 * The class names a module scope recognises as log contexts: every controller, provider and
 * injectable declared in a module of the closure.
 */
function contextsInScope(context: ToolContext, scope: InstanceScope): ReadonlySet<string> | null {
  if (scope.kind !== 'module') return null;
  const model = context.graph.read();
  if (isGraphUnavailable(model)) return null;
  const names = new Set<string>();
  for (const graphClass of Object.values(model.classes)) {
    const module = model.modules[graphClass.module];
    if (module && scope.modules.has(module.name)) names.add(graphClass.name);
  }
  return names;
}

export function logsTail(tee: LogTee, input: LogsTailInput, contexts: ReadonlySet<string> | null) {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const minRank = input.minLevel === undefined ? -1 : LOG_LEVELS.indexOf(input.minLevel);
  const needle = input.contains?.toLowerCase();
  const held = input.sinceSeq === undefined ? tee.buffer.all() : tee.buffer.since(input.sinceSeq);

  const matching = held.filter(
    (entry) =>
      (input.level === undefined || entry.level === input.level) &&
      LOG_LEVELS.indexOf(entry.level) >= minRank &&
      (input.context === undefined || entry.context === input.context) &&
      (contexts === null || (entry.context !== null && contexts.has(entry.context))) &&
      (needle === undefined ||
        entry.message.toLowerCase().includes(needle) ||
        (entry.stack?.toLowerCase().includes(needle) ?? false)),
  );

  // Paging forward reads the oldest first; a plain tail reads the newest.
  const paging = input.sinceSeq !== undefined;
  const entries = paging ? matching.slice(0, limit) : matching.slice(-limit);
  const more = paging && matching.length > limit;
  const answer: Omit<LogsTailAnswer, 'scope'> = {
    entries,
    lastSeq: more ? entries[entries.length - 1]!.seq : tee.buffer.lastSeq,
    more,
  };
  const oldest = tee.buffer.all()[0]?.seq ?? tee.buffer.lastSeq + 1;
  if (paging && oldest - input.sinceSeq! - 1 > 0) answer.dropped = oldest - input.sinceSeq! - 1;
  return answer;
}

export function registerLogsTools(registry: ToolRegistry, context: ToolContext): void {
  const tee = (): LogTee => {
    if (!context.logTee) {
      throw new ToolError(
        'logs_not_installed',
        'The Logger tee is installed when the app finishes bootstrapping; call again once it has.',
      );
    }
    return context.logTee;
  };
  const level = z.enum(LOG_LEVELS);

  registry.register('logs', {
    name: 'logs_tail',
    description:
      "The latest entries the app wrote through Nest's Logger (whatever logger it set with " +
      'useLogger), oldest first: seq, timestamp, level, context, message and, for errors, stack. ' +
      'Filter by exact level, minimum level, exact context or a case-insensitive substring of the ' +
      'message. Pass the answered lastSeq as sinceSeq to read only what came after. A module-scoped ' +
      "instance keeps only entries whose context is a class in its scope; scope: 'app' lifts that. " +
      "What a logger writes outside Nest's Logger (pino-http request lines, for example) is not here.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`At most this many entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      level: level.optional().describe('Only this level'),
      minLevel: level.optional().describe('This level and the more severe ones'),
      context: z.string().optional().describe('Exact context, usually a class name'),
      contains: z.string().optional().describe('Case-insensitive substring of message or stack'),
      sinceSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only entries after this seq, oldest first'),
      scope: z
        .enum(['instance', 'app'])
        .optional()
        .describe("'app' reads every entry, even from a module-scoped instance"),
    },
    handler: (input): LogsTailAnswer => {
      const typed = input as LogsTailInput;
      const instanceScope = context.scope();
      const lifted = typed.scope === 'app';
      const contexts = lifted ? null : contextsInScope(context, instanceScope);
      const answer = logsTail(tee(), typed, contexts);
      return {
        scope: lifted ? { kind: 'app' } : describeScope(instanceScope),
        ...(contexts ? { scopeFilter: 'context-is-class-in-scope' as const } : {}),
        ...answer,
      };
    },
  });

  registry.register('logs', {
    name: 'logs_levels',
    description:
      "The log levels the app's logger has on (null when it cannot say) and the ring buffer the " +
      'inspector keeps: its size, how many entries it holds and the newest seq.',
    handler: () => {
      const active = tee();
      return {
        scope: describeScope(context.scope()),
        levels: active.levels(),
        buffer: {
          size: active.buffer.size,
          length: active.buffer.length,
          lastSeq: active.buffer.lastSeq,
        },
      };
    },
  });
}
