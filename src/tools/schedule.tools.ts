import { z } from 'zod';
import { describeScope, inScope, type AnswerScope } from '../instance/scope.js';
import { readJobs } from '../schedule/jobs-reader.js';
import type { ScheduledJobKind, ScheduledJobModel } from '../schedule/model.js';
import { lastRunOf } from '../runs/present.js';
import { moduleNamer } from './module-name.js';
import { ToolError, type ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

export interface ScheduleJobsAnswer {
  scope: AnswerScope;
  /** Cron jobs, then intervals, then timeouts, each in the registry's order. */
  jobs: ScheduledJobModel[];
}

export function registerScheduleTools(registry: ToolRegistry, context: ToolContext): void {
  registry.register('schedule', {
    name: 'schedule_jobs',
    description:
      "The jobs in @nestjs/schedule's SchedulerRegistry: cron jobs with their expression, " +
      'running state, when it last fired and fires next; intervals with their period (everyMs); timeouts with ' +
      'their delay (delayMs) and whether they are still pending. Jobs declared with @Cron, ' +
      '@Interval or @Timeout carry their class, method and module. A module-scoped instance lists ' +
      "only jobs declared by classes in its scope; scope: 'app' lifts it and also lists jobs the " +
      'app added to the registry itself. With the runs tools on, decorated jobs carry lastRun: the ' +
      'latest recorded run (id, startedAt, outcome, durationMs); runs_list has its error.',
    inputSchema: {
      kind: z.enum(['cron', 'interval', 'timeout']).optional().describe('Only jobs of this kind'),
      scope: z
        .enum(['instance', 'app'])
        .optional()
        .describe("'app' lists every job, even from a module-scoped instance"),
    },
    handler: (input): ScheduleJobsAnswer => {
      const typed = input as { kind?: ScheduledJobKind; scope?: 'instance' | 'app' };
      const schedule = context.schedule;
      if (!schedule) {
        throw new ToolError(
          'schedule_not_installed',
          'The registry is looked up while the app initialises; call again once it has.',
        );
      }
      const instanceScope = typed.scope === 'app' ? { kind: 'app' as const } : context.scope();
      const namer = moduleNamer(context.graph);
      const jobs = readJobs(schedule.registry, schedule.container, namer)
        .filter((job) => typed.kind === undefined || job.kind === typed.kind)
        // A job without a declaring class has no module: only an app-wide answer can place it.
        .filter((job) =>
          job.module === undefined
            ? instanceScope.kind !== 'module'
            : inScope(instanceScope, job.module),
        );
      const { runs } = context;
      if (runs) {
        for (const job of jobs) {
          const lastRun = lastRunOf(runs, namer, { ...job, kinds: [job.kind] });
          if (lastRun) job.lastRun = lastRun;
        }
      }
      return { scope: describeScope(instanceScope), jobs };
    },
  });
}
