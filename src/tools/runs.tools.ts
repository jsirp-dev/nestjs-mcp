import { z } from 'zod';
import { describeScope, inScope, type AnswerScope } from '../instance/scope.js';
import { logsOf } from '../logs/log-origin.js';
import type { LogEntry } from '../logs/model.js';
import type { RunsInspector } from '../runs/install-runs.js';
import {
  RUN_KINDS,
  RUN_OUTCOMES,
  type RunKind,
  type RunModel,
  type RunOutcome,
} from '../runs/model.js';
import { presentRun } from '../runs/present.js';
import { moduleNamer } from './module-name.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
/** Log entries `run_get` lists per run; beyond that, the newest. */
export const MAX_RUN_LOGS = 200;

export interface RunsListInput {
  kind?: RunKind;
  name?: string;
  event?: string;
  outcome?: RunOutcome;
  limit?: number;
  scope?: 'instance' | 'app';
}

export interface RunsListAnswer {
  scope: AnswerScope;
  /** Oldest first: the newest `limit` that match. */
  runs: RunModel[];
}

/** A run as `run_get` answers it, with what it logged when the `logs` group is on. */
export type RunAnswer = RunModel & {
  logs?: LogEntry[];
  /** More entries than `MAX_RUN_LOGS` matched; the oldest were left out. */
  logsTruncated?: true;
  /** The logs buffer already discarded some of this run's entries. */
  logsDropped?: true;
};

export function registerRunsTools(registry: ToolRegistry, context: ToolContext): void {
  const runs = (): RunsInspector => {
    if (!context.runs) {
      throw new ToolError(
        'runs_not_installed',
        'The jobs and listeners are wrapped while the app initialises; call again once it has.',
      );
    }
    return context.runs;
  };
  const scopeInput = z
    .enum(['instance', 'app'])
    .optional()
    .describe("'app' lists every run, even from a module-scoped instance");
  const scopeFor = (lift: boolean) => {
    const scope = lift ? { kind: 'app' as const } : context.scope();
    return { scope, answer: describeScope(scope) };
  };

  registry.register('runs', {
    name: 'runs_list',
    description:
      'The latest runs of scheduled jobs (@Cron, @Interval, @Timeout of @nestjs/schedule) and ' +
      '@OnEvent listeners (@nestjs/event-emitter), oldest first: id, kind, class, method, module, ' +
      'job name or emitted event, start, duration, outcome (running, ok or threw) and, when it ' +
      'threw, the error name and message, even when the scheduler or the emitter swallowed it. ' +
      'requestId when it ran inside a traced request. Never the event payload or the job ' +
      'arguments. Only runs started by the scheduler or the emitter are recorded, not calls the ' +
      'app makes to the method itself, nor REQUEST-scoped listeners. name matches the job name ' +
      'or Class.method; event is a substring of the event or a pattern the emitter would match. ' +
      "A module-scoped instance lists runs of classes in its scope; scope: 'app' lifts it.",
    inputSchema: {
      kind: z
        .enum(RUN_KINDS as [RunKind, ...RunKind[]])
        .optional()
        .describe('Only runs of this kind'),
      name: z.string().min(1).optional().describe('A job name, or Class.method'),
      event: z
        .string()
        .min(1)
        .optional()
        .describe('A substring of the event, or a pattern such as cat.* with wildcards on'),
      outcome: z
        .enum(RUN_OUTCOMES as [RunOutcome, ...RunOutcome[]])
        .optional()
        .describe('Only runs with this outcome'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`At most this many, the newest (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      scope: scopeInput,
    },
    handler: (input): RunsListAnswer => {
      const typed = input as RunsListInput;
      const active = runs();
      const { scope, answer } = scopeFor(typed.scope === 'app');
      const namer = moduleNamer(context.graph);
      const limit = Math.min(typed.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const matching = active.buffer
        .all()
        .map((entry) => presentRun(entry, namer))
        .filter(
          (run) =>
            inScope(scope, run.module) &&
            (typed.kind === undefined || run.kind === typed.kind) &&
            (typed.outcome === undefined || run.outcome === typed.outcome) &&
            (typed.name === undefined ||
              run.name === typed.name ||
              `${run.className}.${run.methodName}` === typed.name) &&
            (typed.event === undefined ||
              (run.event !== undefined &&
                (run.event.includes(typed.event) ||
                  (active.matches?.(typed.event, run.event) ?? false)))),
        );
      return { scope: answer, runs: matching.slice(-limit) };
    },
  });

  registry.register('runs', {
    name: 'run_get',
    description:
      'One job or listener run by id (from runs_list): what runs_list shows and, when the logs ' +
      'tools are on, logs, what the app logged during the run that the logs buffer still holds, ' +
      `oldest first, at most ${MAX_RUN_LOGS} (the newest; logsTruncated says more matched), and ` +
      'logsDropped when the buffer already discarded some of them. The line the scheduler or the ' +
      'emitter logs after a method threw is written outside the run; error carries what it threw.',
    inputSchema: {
      id: z.string().min(1).describe('A run id from runs_list'),
      scope: scopeInput,
    },
    handler: (input) => {
      const { id, scope: lift } = input as { id: string; scope?: 'instance' | 'app' };
      const active = runs();
      const { scope, answer } = scopeFor(lift === 'app');
      const entry = active.buffer.all().find((candidate) => candidate.run.id === id);
      if (!entry) {
        throw new ToolError(
          'not_found',
          `No run with id ${id}. The buffer keeps the last ${active.buffer.size} runs; ` +
            'runs_list shows the ids it holds.',
          { scope: answer },
        );
      }
      const presented: RunAnswer = presentRun(entry, moduleNamer(context.graph));
      if (!inScope(scope, presented.module)) {
        throw new ToolError(
          'not_found',
          `The run ${id} is outside this instance's scope; pass scope: 'app' to read it.`,
          { scope: answer },
        );
      }
      if (context.logs) {
        const { entries, dropped } = logsOf(context.logs.buffer, entry.run);
        presented.logs = entries.slice(-MAX_RUN_LOGS);
        if (entries.length > MAX_RUN_LOGS) presented.logsTruncated = true;
        if (dropped) presented.logsDropped = true;
      }
      return { scope: answer, run: presented };
    },
  });
}
