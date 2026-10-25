import { z } from 'zod';
import { isGraphUnavailable } from '../graph/model.js';
import { describeScope, type AnswerScope, type InstanceScope } from '../instance/scope.js';
import type { LogsInspector } from '../logs/install-logs.js';
import {
  LOG_LEVELS,
  LOG_SOURCES,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from '../logs/model.js';
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
  source?: LogSource;
  sinceSeq?: number;
  requestId?: string;
  runId?: string;
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

export function logsTail(
  logs: Pick<LogsInspector, 'buffer'>,
  input: LogsTailInput,
  contexts: ReadonlySet<string> | null,
) {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const minRank = input.minLevel === undefined ? -1 : LOG_LEVELS.indexOf(input.minLevel);
  const needle = input.contains?.toLowerCase();
  const { buffer } = logs;
  const held = input.sinceSeq === undefined ? buffer.all() : buffer.since(input.sinceSeq);

  const matching = held.filter(
    (entry) =>
      (input.level === undefined || entry.level === input.level) &&
      (input.source === undefined || entry.source === input.source) &&
      LOG_LEVELS.indexOf(entry.level) >= minRank &&
      (input.context === undefined || entry.context === input.context) &&
      (input.requestId === undefined || entry.requestId === input.requestId) &&
      (input.runId === undefined || entry.runId === input.runId) &&
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
    lastSeq: more ? entries[entries.length - 1]!.seq : buffer.lastSeq,
    more,
  };
  const oldest = buffer.all()[0]?.seq ?? buffer.lastSeq + 1;
  if (paging && oldest - input.sinceSeq! - 1 > 0) answer.dropped = oldest - input.sinceSeq! - 1;
  return answer;
}

export function registerLogsTools(registry: ToolRegistry, context: ToolContext): void {
  const logs = (): LogsInspector => {
    if (!context.logs) {
      throw new ToolError(
        'logs_not_installed',
        'The log capture is installed when the app initialises its modules; call again once it has.',
      );
    }
    return context.logs;
  };
  const level = z.enum(LOG_LEVELS);

  registry.register('logs', {
    name: 'logs_tail',
    description:
      "The latest entries the app wrote through Nest's Logger (whatever logger it set with " +
      "useLogger; source 'nest') and, when the app attached the inspector's log sink to its own " +
      "logger (pino, winston…), that logger's lines (source 'sink'), oldest first: seq, source, " +
      'timestamp, level, context, message and, when known, stack. Filter by exact level, minimum ' +
      'level, source, exact context, the requestId of the request it was written in (as ' +
      'requests_list shows it; entries written outside a request have none), the runId of the ' +
      'job or listener run it was written in (as runs_list shows it) or a ' +
      'case-insensitive substring of the message. Pass the ' +
      'answered lastSeq as sinceSeq to read only what came after. A module-scoped instance keeps ' +
      "only entries whose context is a class in its scope; scope: 'app' lifts that. Without a sink, " +
      "what a logger writes outside Nest's Logger (pino-http request lines, for example) is not here; " +
      'logs_levels says whether a sink is attached.',
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
      source: z
        .enum(LOG_SOURCES as [LogSource, ...LogSource[]])
        .optional()
        .describe("'nest' (Nest's Logger) or 'sink' (the app's own logger, through the sink)"),
      sinceSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only entries after this seq, oldest first'),
      requestId: z
        .string()
        .min(1)
        .optional()
        .describe('Only entries written while this request was traced (its id in requests_list)'),
      runId: z
        .string()
        .min(1)
        .optional()
        .describe('Only entries written during this job or listener run (its id in runs_list)'),
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
      const answer = logsTail(logs(), typed, contexts);
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
      "The log levels Nest's logger has on (null when it cannot say, or when only the sink is " +
      "read), what the buffer captures ('nest', 'sink' or 'both'), the ring buffer the inspector " +
      'keeps (its size, how many entries it holds and the newest seq) and, when a log sink is ' +
      'read, whether it is connected, how many records it received and how many failures it ' +
      'swallowed (null without a sink).',
    handler: () => {
      const active = logs();
      return {
        scope: describeScope(context.scope()),
        levels: active.levels(),
        capture: active.capture,
        buffer: {
          size: active.buffer.size,
          length: active.buffer.length,
          lastSeq: active.buffer.lastSeq,
        },
        sink: active.sink(),
      };
    },
  });
}
