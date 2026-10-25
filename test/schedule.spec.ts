import { SchedulerRegistry } from '@nestjs/schedule';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readJobs } from '../src/schedule/jobs-reader.js';
import type { ContainerLike } from '../src/support/for-each-instance.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe('schedule tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}, path = '_mcp'): Promise<Client> {
    running = await startApp({ schedule: true, ...options });
    return running.connect(path);
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  const registry = () => running!.app.get(SchedulerRegistry);
  const byName = (json: Json, name: string) => json.jobs.find((job: Json) => job.name === name);

  it('lists the cron cleanup with its class, expression and an ISO nextRun', async () => {
    const client = await boot();
    const { json } = await call(client, 'schedule_jobs');
    expect(json.scope).toEqual({ kind: 'app' });
    const cleanup = byName(json, 'cleanup');
    expect(cleanup).toMatchObject({
      kind: 'cron',
      name: 'cleanup',
      className: 'CatsService',
      methodName: 'cleanup',
      module: 'CatsModule',
      expression: '0 3 * * *',
      running: true,
    });
    expect(cleanup.nextRun).toMatch(ISO);
    expect(Date.parse(cleanup.nextRun)).toBeGreaterThan(Date.now());
    expect(new Date(cleanup.nextRun).getHours()).toBe(3);
    expect(cleanup).not.toHaveProperty('lastRun');
  });

  it('matches an unnamed decorated cron back to its method by expression', async () => {
    const client = await boot();
    const { json } = await call(client, 'schedule_jobs', { kind: 'cron' });
    const weekly = json.jobs.find((job: Json) => job.methodName === 'weeklyReport');
    expect(weekly).toMatchObject({
      kind: 'cron',
      className: 'CatsService',
      expression: '0 4 * * 0',
    });
    expect(weekly.name).not.toBe('weeklyReport');
  });

  it('lists decorated intervals and timeouts with their period', async () => {
    const client = await boot({ health: true });
    const { json } = await call(client, 'schedule_jobs');
    expect(byName(json, 'refresh')).toEqual({
      kind: 'interval',
      name: 'refresh',
      className: 'CatsService',
      methodName: 'refresh',
      module: 'CatsModule',
      everyMs: 3_600_000,
      running: true,
    });
    expect(byName(json, 'warmup')).toEqual({
      kind: 'timeout',
      name: 'warmup',
      className: 'HealthController',
      methodName: 'warmup',
      module: 'HealthModule',
      delayMs: 3_600_000,
      running: true,
    });
  });

  it('lists intervals, timeouts and cron jobs added through SchedulerRegistry', async () => {
    const client = await boot();
    registry().addInterval(
      'poll',
      setInterval(() => undefined, 5_000),
    );
    registry().addTimeout(
      'once',
      setTimeout(() => undefined, 7_000),
    );
    const CronJob = registry().getCronJob('cleanup').constructor as new (
      expression: string,
      onTick: () => void,
    ) => ReturnType<SchedulerRegistry['getCronJob']>;
    registry().addCronJob('dynamic', new CronJob('*/10 * * * *', () => undefined));
    const { json } = await call(client, 'schedule_jobs');
    expect(byName(json, 'poll')).toEqual({
      kind: 'interval',
      name: 'poll',
      everyMs: 5_000,
      running: true,
    });
    expect(byName(json, 'once')).toEqual({
      kind: 'timeout',
      name: 'once',
      delayMs: 7_000,
      running: true,
    });
    // Never started: the job exists, it will not run.
    expect(byName(json, 'dynamic')).toEqual({
      kind: 'cron',
      name: 'dynamic',
      expression: '*/10 * * * *',
      running: false,
    });
  });

  it('a stopped cron has no nextRun, and a fired timeout is no longer running', async () => {
    const client = await boot();
    registry().getCronJob('cleanup').stop();
    registry().addTimeout(
      'soon',
      setTimeout(() => undefined, 1),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { json } = await call(client, 'schedule_jobs');
    expect(byName(json, 'cleanup')).toMatchObject({ running: false });
    expect(byName(json, 'cleanup')).not.toHaveProperty('nextRun');
    expect(byName(json, 'soon')).toMatchObject({ kind: 'timeout', running: false });
  });

  it('filters by kind', async () => {
    const client = await boot({ health: true });
    const kinds = async (kind: string) =>
      (await call(client, 'schedule_jobs', { kind })).json.jobs.map((job: Json) => job.kind);
    expect(new Set(await kinds('cron'))).toEqual(new Set(['cron']));
    expect(await kinds('interval')).toEqual(['interval']);
    expect(await kinds('timeout')).toEqual(['timeout']);
  });

  it('a module-scoped instance lists only jobs declared by classes in its scope', async () => {
    const client = await boot({ catsInspector: true, health: true }, CATS_INSPECTOR_PATH);
    registry().addInterval(
      'poll',
      setInterval(() => undefined, 5_000),
    );
    const { json } = await call(client, 'schedule_jobs');
    expect(json.scope).toEqual({ kind: 'module', module: 'CatsModule' });
    const names = json.jobs.map((job: Json) => job.name);
    expect(names).toContain('cleanup');
    expect(names).not.toContain('warmup');
    // No declaring class, so no module: only an app-wide answer lists it.
    expect(names).not.toContain('poll');
    const wide = (await call(client, 'schedule_jobs', { scope: 'app' })).json;
    expect(wide.scope).toEqual({ kind: 'app' });
    expect(wide.jobs.map((job: Json) => job.name)).toEqual(
      expect.arrayContaining(['cleanup', 'warmup', 'poll']),
    );
  });

  it('app_info reports the schedule group live', async () => {
    const client = await boot();
    const { json } = await call(client, 'app_info');
    expect(json.tools.schedule).toBe(true);
  });

  it('an app that does not import ScheduleModule boots with no schedule_* tool', async () => {
    const client = await boot({ schedule: false });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('schedule_'))).toEqual([]);
    expect((await call(client, 'app_info')).json.tools.schedule).toBe(false);
  });

  it('with tools.schedule off, nothing is registered', async () => {
    const client = await boot({ root: { kind: 'sync', options: { tools: { schedule: false } } } });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('schedule_'))).toEqual([]);
  });
});

describe('readJobs', () => {
  /** A container with one provider whose prototype carries the given metadata on `method`. */
  function containerWith(metadata: Record<string, unknown>): ContainerLike {
    class LegacyJobs {
      method(): void {}
    }
    for (const [key, value] of Object.entries(metadata)) {
      Reflect.defineMetadata(key, value, LegacyJobs.prototype.method);
    }
    const wrapper = { token: LegacyJobs, metatype: LegacyJobs, instance: new LegacyJobs() };
    return [
      { id: 'm', name: 'LegacyModule', providers: new Map([[LegacyJobs, wrapper]]) },
    ] as unknown as ContainerLike;
  }

  /** A `SchedulerRegistry` holding one cron job shaped as `cron` 3 shapes it. */
  function registryWith(name: string, job: object) {
    return {
      getCronJobs: () => new Map([[name, job]]),
      getIntervals: () => [],
      getTimeouts: () => [],
      getInterval: () => undefined,
      getTimeout: () => undefined,
    };
  }

  it('reads cron 3 jobs (running, nextDate().toISO()) and cron options without SCHEDULER_NAME', () => {
    const container = containerWith({
      SCHEDULE_CRON_OPTIONS: { cronTime: '0 5 * * *', name: 'legacy', timeZone: 'Europe/Madrid' },
    });
    const job = {
      running: true,
      cronTime: { source: '0 5 * * *' },
      nextDate: () => ({ toISO: () => '2030-01-01T05:00:00.000+01:00' }),
      lastDate: () => new Date('2029-12-31T04:00:00.000Z'),
    };
    expect(readJobs(registryWith('legacy', job), container, () => 'LegacyModule')).toEqual([
      {
        kind: 'cron',
        name: 'legacy',
        className: 'LegacyJobs',
        methodName: 'method',
        module: 'LegacyModule',
        expression: '0 5 * * *',
        timeZone: 'Europe/Madrid',
        running: true,
        lastRun: '2029-12-31T04:00:00.000Z',
        nextRun: '2030-01-01T05:00:00.000+01:00',
      },
    ]);
  });

  it('falls back to toString when nextDate has no toISO, and never throws on odd jobs', () => {
    const job = { isActive: true, cronTime: {}, nextDate: () => ({ toString: () => 'soon' }) };
    const odd = {
      get isActive(): boolean {
        throw new Error('boom');
      },
      nextDate: () => {
        throw new Error('boom');
      },
    };
    const registry = {
      ...registryWith('plain', job),
      getCronJobs: () =>
        new Map<string, object>([
          ['plain', job],
          ['odd', odd],
        ]),
    };
    expect(readJobs(registry, [] as unknown as ContainerLike, () => 'x')).toEqual([
      { kind: 'cron', name: 'plain', running: true, nextRun: 'soon' },
      { kind: 'cron', name: 'odd' },
    ]);
  });
});
