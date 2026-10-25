import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CatsService } from './fixtures/app/cats/cats.service.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { JobsService } from './fixtures/app/runs.module.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('runs tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}, path = '/'): Promise<Client> {
    running = await startApp({ events: true, schedule: true, runs: true, ...options });
    return running.connect(path);
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  /** Calls `runs_list` until `found` picks something out of its runs, for at most two seconds. */
  async function waitForRun(
    client: Client,
    args: Record<string, unknown>,
    found: (run: Json) => boolean = () => true,
  ): Promise<Json> {
    const until = Date.now() + 2000;
    for (;;) {
      const { json } = await call(client, 'runs_list', args);
      const run = (json.runs as Json[]).find(found);
      if (run) return run;
      if (Date.now() > until) throw new Error(`No run for ${JSON.stringify(args)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const fire = (name: string) =>
    (running!.app.get(SchedulerRegistry).getCronJob(name) as { fireOnTick(): void }).fireOnTick();
  const emitter = () => running!.app.get(EventEmitter2);

  it('records a cron that throws, fired through the registry, with its error and lastRun', async () => {
    const client = await boot();
    fire('purge');
    const run = await waitForRun(client, { outcome: 'threw' }, (r) => r.name === 'purge');
    expect(run).toEqual({
      id: expect.any(String),
      kind: 'cron',
      className: 'JobsService',
      methodName: 'purge',
      module: 'RunsModule',
      name: 'purge',
      startedAt: expect.stringMatching(ISO),
      durationMs: expect.any(Number),
      outcome: 'threw',
      error: { name: 'Error', message: 'purge failed' },
    });
    // The scheduler swallowed it: it only logged it.
    expect(running!.app.get(SchedulerRegistry).getCronJob('purge')).toBeDefined();

    const { json } = await call(client, 'schedule_jobs', { kind: 'cron' });
    const purge = json.jobs.find((job: Json) => job.name === 'purge');
    expect(purge.lastRun).toEqual({
      id: run.id,
      startedAt: run.startedAt,
      outcome: 'threw',
      durationMs: run.durationMs,
    });
    const cleanup = json.jobs.find((job: Json) => job.name === 'cleanup');
    expect(cleanup).not.toHaveProperty('lastRun');
  });

  it('records a successful timeout and interval as ok with their duration', async () => {
    const client = await boot();
    const warm = await waitForRun(client, { name: 'warm' }, (r) => r.outcome === 'ok');
    expect(warm).toMatchObject({ kind: 'timeout', methodName: 'warm', outcome: 'ok' });
    expect(warm.durationMs).toBeGreaterThanOrEqual(15);
    const beat = await waitForRun(client, { kind: 'interval' }, (r) => r.outcome === 'ok');
    expect(beat).toMatchObject({ name: 'beat', className: 'JobsService', outcome: 'ok' });
    expect(beat.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('lists the lines logged inside a run in run_get, and logs_tail filters them by runId', async () => {
    const client = await boot();
    fire('purge');
    const run = await waitForRun(client, { name: 'purge' }, (r) => r.outcome === 'threw');
    const { json } = await call(client, 'run_get', { id: run.id });
    expect(json.run).toMatchObject({ id: run.id, outcome: 'threw' });
    expect(json.run.logs.map((entry: Json) => [entry.context, entry.message])).toEqual([
      ['JobsService', 'purging'],
    ]);
    expect(json.run.logs[0].runId).toBe(run.id);
    expect(json.run).not.toHaveProperty('logsDropped');

    const tail = await call(client, 'logs_tail', { runId: run.id });
    expect(tail.json.entries.map((entry: Json) => entry.seq)).toEqual(
      json.run.logs.map((entry: Json) => entry.seq),
    );
    // The line the scheduler writes once the method threw is outside the run.
    const scheduler = await call(client, 'logs_tail', { context: 'Scheduler' });
    expect(scheduler.json.entries.length).toBeGreaterThan(0);
    expect(scheduler.json.entries[0]).not.toHaveProperty('runId');
  });

  it('records a listener run of an async listener called on a later tick, with its line', async () => {
    const client = await boot();
    await emitter().emitAsync('job.later');
    const run = await waitForRun(client, { event: 'job.later' }, (r) => r.outcome === 'ok');
    expect(run).toMatchObject({ kind: 'listener', methodName: 'later', event: 'job.later' });
    const { json } = await call(client, 'run_get', { id: run.id });
    expect(json.run.logs.map((entry: Json) => entry.message)).toEqual(['later']);
  });

  it('answers not_found for an unknown run id', async () => {
    const client = await boot();
    const { json, isError } = await call(client, 'run_get', { id: 'nope' });
    expect(isError).toBe(true);
    expect(json.error).toBe('not_found');
  });

  describe('listeners that throw', () => {
    /** Emits the same events on an app with or without the inspector and keeps what came back. */
    async function outcomes(app: RunningApp) {
      const events = app.app.get(EventEmitter2);
      const settle = (promise: unknown) =>
        (promise as Promise<unknown>).then(
          (value) => ({ resolved: value }),
          (error: Error) => ({ rejected: [error.constructor.name, error.message] }),
        );
      return {
        emitFailed: events.emit('job.failed'),
        emitAsyncFailed: await settle(events.emitAsync('job.failed')),
        emitAsyncFailedAsync: await settle(events.emitAsync('job.failed.async')),
        emitAsyncStrict: await settle(events.emitAsync('job.strict')),
        emitAsyncDone: await settle(events.emitAsync('job.done', { n: 1 })),
        emitDone: events.emit('job.done', { n: 2 }),
        emitNobody: events.emit('job.nobody'),
        // An `async: true` listener answers with eventemitter2's timer handle: compared by type.
        emitAsyncLater: await (events.emitAsync('job.later') as Promise<unknown[]>).then((values) =>
          values.map((value) => (value as object)?.constructor?.name ?? typeof value),
        ),
      };
    }

    it('are recorded as threw, sync or async, and the emitter answers as without the inspector', async () => {
      const client = await boot();
      const inspected = await outcomes(running!);
      const plain = await startApp({
        events: true,
        schedule: true,
        runs: true,
        root: { kind: 'none' },
      });
      try {
        expect(inspected).toEqual(await outcomes(plain));
      } finally {
        await plain.close();
      }
      expect(inspected.emitAsyncStrict).toEqual({ rejected: ['TypeError', 'strict failed'] });
      expect(inspected.emitAsyncDone).toEqual({ resolved: ['jobs:1'] });
      expect(running!.app.get(JobsService).received).toEqual([{ n: 1 }, { n: 2 }]);

      const failed = await waitForRun(client, { event: 'job.failed', outcome: 'threw' });
      expect(failed).toMatchObject({
        kind: 'listener',
        className: 'JobsService',
        methodName: 'onFailed',
        event: 'job.failed',
        error: { name: 'Error', message: 'listener failed' },
      });
      const asyncFailed = await waitForRun(client, { name: 'JobsService.onFailedAsync' });
      expect(asyncFailed).toMatchObject({
        outcome: 'threw',
        error: { message: 'async listener failed' },
      });
      const strict = await waitForRun(client, { name: 'JobsService.onStrict' });
      expect(strict).toMatchObject({ outcome: 'threw', error: { name: 'TypeError' } });
      const { json } = await call(client, 'runs_list', { name: 'JobsService.onFailed' });
      expect(json.runs).toHaveLength(2);

      const listeners = await call(client, 'events_listeners', { event: 'job.failed' });
      const onFailed = listeners.json.listeners.find((l: Json) => l.methodName === 'onFailed');
      expect(onFailed.lastRun).toMatchObject({ outcome: 'threw', id: json.runs[1].id });
    });
  });

  it('does not record calls the app makes to the methods itself', async () => {
    const client = await boot();
    const jobs = running!.app.get(JobsService);
    expect(() => jobs.purge()).toThrow('purge failed');
    await expect(jobs.onDone({ n: 3 })).resolves.toBe('jobs:3');
    expect(Object.prototype.hasOwnProperty.call(jobs, 'purge')).toBe(false);
    const { json } = await call(client, 'runs_list', { kind: 'cron' });
    expect(json.runs).toEqual([]);
    const listeners = await call(client, 'runs_list', { kind: 'listener' });
    expect(listeners.json.runs).toEqual([]);
  });

  it('a forFeature instance only lists runs of jobs and listeners in its scope', async () => {
    const client = await boot({ catsInspector: true, health: true }, CATS_INSPECTOR_PATH);
    fire('cleanup');
    fire('purge');
    emitter().emit('cat.adopted', { id: 1, owner: 'Ann' });
    emitter().emit('job.done', { n: 1 });
    emitter().emit('app.ready');
    await waitForRun(client, { name: 'cleanup' });
    const app = running!.connect('/');
    await waitForRun(await app, { name: 'purge' });

    const { json } = await call(client, 'runs_list');
    expect(json.scope).toEqual({ kind: 'module', module: 'CatsModule' });
    expect(json.runs.map((run: Json) => `${run.className}.${run.methodName}`).sort()).toEqual([
      'CatsService.cleanup',
      'CatsService.onCatAdopted',
    ]);
    const lifted = await call(client, 'runs_list', { scope: 'app' });
    const names = lifted.json.runs.map((run: Json) => `${run.className}.${run.methodName}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'JobsService.purge',
        'JobsService.onDone',
        'HealthController.onAppReady',
      ]),
    );
    const purge = lifted.json.runs.find((run: Json) => run.name === 'purge');
    const outside = await call(client, 'run_get', { id: purge.id });
    expect(outside.isError).toBe(true);
    expect(outside.json.error).toBe('not_found');
  });

  it('records a listener run inside a traced request with its request id', async () => {
    const client = await boot();
    const response = await running!.fetch('/jobs/done/7', {
      method: 'POST',
      headers: { 'x-nest-mcp-request-id': 'done-7' },
    });
    expect(await response.json()).toEqual(['jobs:7']);
    const run = await waitForRun(client, { event: 'job.done' });
    expect(run).toMatchObject({ methodName: 'onDone', outcome: 'ok', requestId: 'done-7' });
    const { json } = await call(client, 'run_get', { id: run.id });
    expect(json.run.logs[0]).toMatchObject({
      message: 'done 7',
      runId: run.id,
      requestId: 'done-7',
    });
    const trace = await call(client, 'request_trace', { id: 'done-7' });
    expect(trace.json.trace.logs.map((entry: Json) => entry.message)).toContain('done 7');
  });

  it('with tools.runs off, wraps nothing and registers no runs tool', async () => {
    const client = await boot({ root: { kind: 'sync', options: { tools: { runs: false } } } });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('run'))).toEqual([]);
    expect(names).toContain('schedule_jobs');
    const jobs = running!.app.get(JobsService);
    expect(Object.prototype.hasOwnProperty.call(jobs, 'onDone')).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(running!.app.get(CatsService), 'onCatAdopted'),
    ).toBe(false);
    fire('purge');
    const { json } = await call(client, 'schedule_jobs', { kind: 'cron' });
    expect(json.jobs.find((job: Json) => job.name === 'purge')).not.toHaveProperty('lastRun');
    const info = await call(client, 'app_info');
    expect(info.json.tools.runs).toBe(false);
  });

  it('with neither peer module imported, registers no runs tool', async () => {
    const client = await boot({ events: false, schedule: false, runs: false });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('run'))).toEqual([]);
  });
});
