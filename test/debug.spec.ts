import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SchedulerRegistry } from '@nestjs/schedule';
import { API_KEY, API_KEY_HEADER } from './fixtures/app/cats/api-key.guard.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ID_HEADER = 'x-nest-mcp-request-id';
const FIXTURES = join(__dirname, 'fixtures', 'app');

/** The 1-based line of `fixtures/app/<file>` that contains `text`. */
function lineOf(file: string, text: string): number {
  const lines = readFileSync(join(FIXTURES, file), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`${text} is not in ${file}`);
  return index + 1;
}

describe('debug option', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(debug: unknown, options: StartAppOptions = {}): Promise<Client> {
    running = await startApp({
      failing: true,
      ...options,
      root: { kind: 'sync', options: debug === undefined ? {} : { debug: debug as boolean } },
    });
    return running.connect('/');
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    return toolJson(await client.callTool({ name, arguments: args })) as Json;
  }

  async function traceOf(client: Client, path: string, id: string, headers = {}): Promise<Json> {
    const response = await running!.fetch(path, { headers: { [ID_HEADER]: id, ...headers } });
    await response.text();
    return (await call(client, 'request_trace', { id })).trace;
  }

  const failing = (trace: Json, kind: string) =>
    trace.steps.find((step: Json) => step.kind === kind && step.error);

  it('is off by default: errors keep exactly their name and message', async () => {
    const client = await boot(undefined);
    const trace = await traceOf(client, '/failing/plain', 'off');
    expect(Object.keys(failing(trace, 'handler').error)).toEqual(['name', 'message']);
    expect((await call(client, 'app_info')).debug).toMatchObject({ enabled: false });
  });

  it("points the failing handler's first frame at the line of its throw", async () => {
    const client = await boot(true);
    const trace = await traceOf(client, '/failing/plain', 'plain');
    const { stack } = failing(trace, 'handler').error;
    expect(stack[0]).toMatchObject({
      function: 'FailingController.plain',
      file: join(FIXTURES, 'failing.module.ts'),
      line: lineOf('failing.module.ts', "throw new Error('plain failure')"),
      mapped: true,
    });
    expect(stack[0].external).toBeUndefined();
  });

  it('gives the stack to a guard that throws and to the filter that catches', async () => {
    const client = await boot(true);
    const denied = await traceOf(client, '/cats', 'denied');
    expect(failing(denied, 'guard').error.stack[0]).toMatchObject({
      file: join(FIXTURES, 'cats', 'api-key.guard.ts'),
      line: lineOf('cats/api-key.guard.ts', 'throw new UnauthorizedException'),
    });

    const missing = await traceOf(client, '/cats/999', 'missing', { [API_KEY_HEADER]: API_KEY });
    const thrown = lineOf('cats/cats.controller.ts', 'throw new NotFoundException');
    const filter = missing.steps.find((step: Json) => step.kind === 'filter');
    expect(filter.outcome).toBe('caught');
    expect(filter.error.stack[0]).toMatchObject({
      line: thrown,
      function: 'CatsController.findOne',
    });
    expect(failing(missing, 'handler').error.stack[0]).toMatchObject({ line: thrown });
  });

  it('flags node_modules and node: frames as external and keeps at most 30', async () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    try {
      const client = await boot(true);
      const trace = await traceOf(client, '/failing/deep/60', 'deep');
      const { stack } = failing(trace, 'handler').error;
      expect(stack).toHaveLength(30);
      expect(stack.every((frame: Json) => frame.function.includes('descend'))).toBe(true);

      const shallow = await traceOf(client, '/failing/plain', 'shallow');
      const frames: Json[] = failing(shallow, 'handler').error.stack;
      const external = frames.filter((frame) => frame.external);
      expect(external.length).toBeGreaterThan(0);
      for (const frame of external) {
        expect(frame.file.startsWith('node:') || frame.file.includes('/node_modules/')).toBe(true);
      }
      expect(
        frames.filter((frame) => !frame.external).every((f) => !f.file.includes('node_modules')),
      ).toBe(true);
    } finally {
      Error.stackTraceLimit = limit;
    }
  });

  it('takes `stackFrames` from the object form', async () => {
    const client = await boot({ stackFrames: 2 });
    const trace = await traceOf(client, '/failing/plain', 'two');
    expect(failing(trace, 'handler').error.stack).toHaveLength(2);
    expect((await call(client, 'app_info')).debug).toMatchObject({ enabled: true, stackFrames: 2 });
  });

  it('reports itself and whether source maps are applied in app_info', async () => {
    const client = await boot(true);
    const info = await call(client, 'app_info');
    expect(info.debug).toEqual({
      enabled: true,
      stackFrames: 30,
      sourceMaps: { process: false, files: expect.any(Number) },
    });
    expect(info.options.debug).toEqual({ enabled: true, stackFrames: 30 });
  });

  it('is process-wide: one instance decides for every instance of the app', async () => {
    const client = await boot(true, { catsInspector: { path: 'cats', debug: false } });
    const cats = await running!.connect('/cats');
    const root = await call(client, 'app_info');
    const feature = await call(cats, 'app_info');
    expect(root.options.debug.enabled).toBe(true);
    expect(feature.options.debug.enabled).toBe(false);
    expect(feature.debug.enabled).toBe(root.debug.enabled);
    await cats.close();
  });

  it('gives the stack to the error of a job run', async () => {
    const client = await boot(true, { events: true, schedule: true, runs: true });
    (
      running!.app.get(SchedulerRegistry).getCronJob('purge') as { fireOnTick(): void }
    ).fireOnTick();
    const { runs } = await call(client, 'runs_list', { outcome: 'threw', kind: 'cron' });
    const { run } = await call(client, 'run_get', { id: runs[0].id });
    expect(run.error.stack[0]).toMatchObject({
      function: 'JobsService.purge',
      file: join(FIXTURES, 'runs.module.ts'),
      line: lineOf('runs.module.ts', "throw new Error('purge failed')"),
    });
  });

  it('rejects a debug option of the wrong shape', async () => {
    for (const debug of ['yes', { stackFrames: 0 }, { stackFrames: 31 }]) {
      const started = startApp({ root: { kind: 'sync', options: { debug } as never } }).then(
        (app) => app.close(),
      );
      await expect(started).rejects.toThrow(/`debug/);
    }
  });
});
