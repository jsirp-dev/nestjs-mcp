import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SchedulerRegistry } from '@nestjs/schedule';
import { API_KEY, API_KEY_HEADER } from './fixtures/app/cats/api-key.guard.js';
import { getterCalls } from './fixtures/app/failing.module.js';
import {
  RecordingLogger,
  RunningApp,
  StartAppOptions,
  startApp,
  toolJson,
} from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

// The module object itself, which the built package reads `Worker` from at each use.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerThreads = require('node:worker_threads') as typeof import('node:worker_threads');

/** Spies on `Worker` while constructing real ones (a class cannot be called without `new`). */
function spyOnWorker() {
  const Original = workerThreads.Worker;
  return jest
    .spyOn(workerThreads, 'Worker')
    .mockImplementation((...args) => new Original(...(args as [string])));
}

const ID_HEADER = 'x-nest-mcp-request-id';
const FIXTURES = join(__dirname, 'fixtures', 'app');

function lineOf(file: string, text: string): number {
  const lines = readFileSync(join(FIXTURES, file), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`${text} is not in ${file}`);
  return index + 1;
}

describe('debug.locals', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    jest.restoreAllMocks();
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

  async function traceOf(client: Client, path: string, id: string, headers = {}) {
    const response = await running!.fetch(path, { headers: { [ID_HEADER]: id, ...headers } });
    const body = await response.text();
    const { trace } = await call(client, 'request_trace', { id });
    return { trace: trace as Json, status: response.status, body };
  }

  const threw = (trace: Json, kind = 'handler') =>
    trace.steps.find((step: Json) => step.kind === kind && step.outcome === 'threw');

  it("shows the top frame's variables at the throw, aligned with the stack", async () => {
    const client = await boot(true);
    const { trace } = await traceOf(client, '/failing/locals', 'total');
    const { error } = threw(trace);
    expect(error.locals[0]).toMatchObject({
      function: 'FailingController.locals',
      file: join(FIXTURES, 'failing.module.ts'),
      line: lineOf('failing.module.ts', 'throw new Error(`failed with'),
      scopes: { local: { total: 42 } },
    });
    expect(error.locals[0].function).toBe(error.stack[0].function);
    expect(error.locals.length).toBeLessThanOrEqual(5);
    // Nest's frames are not the app's: listed, never read.
    const external = error.locals.filter((frame: Json) => frame.external);
    expect(external.length).toBeGreaterThan(0);
    for (const frame of external) expect(frame.scopes).toBeUndefined();
  });

  it('reads the locals of an async handler after an await', async () => {
    const client = await boot(true);
    const { trace } = await traceOf(client, '/failing/locals-async', 'async');
    expect(threw(trace).error.locals[0].scopes.local).toMatchObject({ resumed: 'after await' });
  });

  it('never calls a getter, and keeps strings and depth within bounds', async () => {
    getterCalls.count = 0;
    const client = await boot(true);
    const { trace } = await traceOf(client, '/failing/locals', 'bounds');
    const { local } = threw(trace).error.locals[0].scopes;
    expect(getterCalls.count).toBe(0);
    expect(local.watched).toEqual({
      plain: 'kept',
      nested: { deeper: '[Object]' },
      counted: '[Getter]',
    });
    expect(local.large.startsWith('x'.repeat(200))).toBe(true);
    expect(local.large).toBe(`${'x'.repeat(200)}…[${1024 * 1024} chars]`);
    expect(Buffer.byteLength(JSON.stringify(threw(trace).error.locals))).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it('takes its bounds from debug.locals and flags a capture the byte budget cut', async () => {
    const client = await boot({ locals: { frames: 1, stringLength: 10, depth: 3, bytes: 300 } });
    const { trace } = await traceOf(client, '/failing/locals', 'small');
    const { error } = threw(trace);
    expect(error.locals).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(error.locals))).toBeLessThanOrEqual(300);
    expect(error.localsTruncated).toBe(true);
  });

  it('skips the capture beyond the rate: the 11th and 12th error of the minute', async () => {
    const client = await boot(true);
    const skipped: unknown[] = [];
    for (let n = 1; n <= 12; n += 1) {
      const { error } = threw((await traceOf(client, '/failing/locals', `rate-${n}`)).trace);
      if (n <= 10) expect(error.locals[0].scopes.local.total).toBe(42);
      else skipped.push(error.localsSkipped);
      if (n > 10) expect(error.locals).toBeUndefined();
    }
    expect(skipped).toEqual(['rate', 'rate']);
    expect((await call(client, 'app_info')).debug.locals).toMatchObject({
      state: 'ready',
      captured: 10,
      skippedRate: 2,
    });
  });

  it('reads nothing outside a traced request or run', async () => {
    const client = await boot(true);
    try {
      const outside = 'no request in flight';
      throw new Error(outside);
    } catch {
      // The test file is app code to the worker: only the empty window keeps it from reading.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await call(client, 'app_info')).debug.locals).toMatchObject({
      captured: 0,
      skippedRate: 0,
    });
  });

  it("does not read Nest's own exceptions", async () => {
    const client = await boot(true);
    // ParseIntPipe throws from node_modules: not the app's frame.
    const { trace } = await traceOf(client, '/failing/deep/abc', 'pipe');
    expect(threw(trace, 'pipe').error.locals).toBeUndefined();
    expect((await call(client, 'app_info')).debug.locals.captured).toBe(0);
  });

  it('keeps the first throw when the app rethrows the same error from a catch', async () => {
    const client = await boot(true);
    const { trace } = await traceOf(client, '/failing/rethrows', 'rethrow');
    const { locals } = threw(trace).error;
    expect(locals[0]).toMatchObject({ function: 'descend', scopes: { local: { depth: 0 } } });
    expect((await call(client, 'app_info')).debug.locals.captured).toBe(1);
  });

  it('puts the locals on the step that threw, not on the filter that caught it', async () => {
    const client = await boot(true);
    const { trace } = await traceOf(client, '/cats/999', 'filter', { [API_KEY_HEADER]: API_KEY });
    expect(threw(trace).error.locals[0].function).toBe('CatsController.findOne');
    const filter = trace.steps.find((step: Json) => step.kind === 'filter');
    expect(filter.outcome).toBe('caught');
    expect(filter.error.stack).toBeDefined();
    expect(filter.error.locals).toBeUndefined();
  });

  it('gives a cron run the locals of its throw', async () => {
    const client = await boot(true, { events: true, schedule: true, runs: true });
    (
      running!.app.get(SchedulerRegistry).getCronJob('purge') as { fireOnTick(): void }
    ).fireOnTick();
    const { runs } = await call(client, 'runs_list', { outcome: 'threw', kind: 'cron' });
    const { run } = await call(client, 'run_get', { id: runs[0].id });
    expect(run.error.locals[0]).toMatchObject({
      function: 'JobsService.purge',
      scopes: { local: { batch: 3 } },
    });
  });

  it('leaves responses, status codes and filters exactly as without debug', async () => {
    const paths = ['/failing/locals', '/failing/locals-async', '/failing/recovers', '/cats/999'];
    const answers = async () => {
      const seen: Array<[number, string]> = [];
      for (const path of paths) {
        const response = await running!.fetch(path, { headers: { [API_KEY_HEADER]: API_KEY } });
        seen.push([response.status, await response.text()]);
      }
      return seen;
    };
    await boot(undefined);
    const plain = await answers();
    await running!.close();
    await boot(true);
    expect(await answers()).toEqual(plain);
    expect(plain.map(([status]) => status)).toEqual([500, 500, 200, 404]);
  });

  it('creates no worker and no inspector session with debug off, or locals off', async () => {
    const spy = spyOnWorker();
    for (const debug of [undefined, false, { locals: false }]) {
      const client = await boot(debug);
      const { trace } = await traceOf(client, '/failing/locals', `off-${String(debug)}`);
      expect(threw(trace).error.locals).toBeUndefined();
      expect((await call(client, 'app_info')).debug.locals.state).toBe('off');
      await running!.close();
      running = undefined;
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns and keeps the stacks when the worker cannot start', async () => {
    jest.spyOn(workerThreads, 'Worker').mockImplementation(() => {
      throw new Error('no threads here');
    });
    const logger = new RecordingLogger();
    const client = await boot(true, { logger });
    const { trace, status } = await traceOf(client, '/failing/locals', 'failed');
    expect(status).toBe(500);
    expect(threw(trace).error.stack[0].function).toBe('FailingController.locals');
    expect(threw(trace).error.locals).toBeUndefined();
    expect((await call(client, 'app_info')).debug.locals).toMatchObject({
      state: 'failed',
      error: 'Error: no threads here',
    });
    const warnings = logger.from('NestMcp').filter((entry) => entry.level === 'warn');
    expect(warnings.map((entry) => entry.message).join('\n')).toMatch(
      /debug\.locals.*no threads here/,
    );
  });

  it('stops the worker when the app closes', async () => {
    const spy = spyOnWorker();
    await boot(true);
    const worker = spy.mock.results[0]!.value as Worker;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    await running!.close();
    running = undefined;
    await expect(exited).resolves.toBeDefined();
  });
});
