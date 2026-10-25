import { Logger } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ID_HEADER = 'x-nest-mcp-request-id';

describe('log entries tied to the request they were written in', () => {
  let running: RunningApp | undefined;
  let client: Client;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}): Promise<void> {
    running = await startApp({ logged: true, ...options });
    client = await running.connect('/');
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Json> {
    const result = await client.callTool({ name, arguments: args });
    return toolJson(result) as Json;
  }

  async function get(path: string, id?: string): Promise<number> {
    const response = await running!.fetch(path, id ? { headers: { [ID_HEADER]: id } } : {});
    await response.text();
    return response.status;
  }

  const messages = (entries: Json[]) => entries.map((entry) => entry.message);

  it('lists in request_trace the lines a failing handler logged, with the step that threw', async () => {
    await boot();
    expect(await get('/logged/lines/other?count=2', 'other')).toBe(200);
    expect(await get('/logged/fail/f1', 'f1')).toBe(500);

    const { trace } = await call('request_trace', { id: 'f1' });
    // The third is Nest's own: its exceptions handler logs the unhandled error inside the request.
    expect(messages(trace.logs)).toEqual(['loading f1', 'about to fail f1', 'failed f1']);
    expect(trace.logs[1]).toMatchObject({
      source: 'nest',
      level: 'warn',
      context: 'LoggedController',
      requestId: 'f1',
    });
    expect(trace.logs[2]).toMatchObject({ level: 'error', context: 'ExceptionsHandler' });
    expect(trace.logsTruncated).toBeUndefined();
    expect(trace.logsDropped).toBeUndefined();
    expect(trace.steps).toContainEqual(
      expect.objectContaining({
        kind: 'handler',
        name: 'LoggedController.fail',
        outcome: 'threw',
        error: { name: 'Error', message: 'failed f1' },
      }),
    );

    const tail = await call('logs_tail', { requestId: 'f1' });
    expect(messages(tail.entries)).toEqual(messages(trace.logs));
    expect(tail.entries.map((entry: Json) => entry.seq)).toEqual(
      trace.logs.map((entry: Json) => entry.seq),
    );
  });

  it('keeps the lines of two concurrent requests apart', async () => {
    await boot();
    await Promise.all([
      get('/logged/lines/a?count=4&delay=5', 'a'),
      get('/logged/lines/b?count=4&delay=5', 'b'),
    ]);

    const a = (await call('request_trace', { id: 'a' })).trace;
    const b = (await call('request_trace', { id: 'b' })).trace;
    expect(messages(a.logs)).toEqual(['a line 0', 'a line 1', 'a line 2', 'a line 3']);
    expect(messages(b.logs)).toEqual(['b line 0', 'b line 1', 'b line 2', 'b line 3']);
    // They did interleave in the buffer: the separation is not an accident of timing.
    const all = await call('logs_tail', { contains: ' line ' });
    expect(messages(all.entries)).not.toEqual([...messages(a.logs), ...messages(b.logs)]);
  });

  it('carries the generated id requests_list shows when the client sent none', async () => {
    await boot();
    await get('/logged/lines/anonymous?count=1');

    const { requests } = await call('requests_list', { path: '/logged/lines/anonymous' });
    const [{ id }] = requests;
    const tail = await call('logs_tail', { contains: 'anonymous line' });
    expect(tail.entries).toEqual([expect.objectContaining({ requestId: id })]);
    expect(messages((await call('request_trace', { id })).trace.logs)).toEqual([
      'anonymous line 0',
    ]);
  });

  it('leaves lines written outside a request without requestId', async () => {
    await boot();
    new Logger('Outside').log('no request here');

    const tail = await call('logs_tail', { context: 'Outside' });
    expect(tail.entries).toHaveLength(1);
    expect('requestId' in tail.entries[0]).toBe(false);
  });

  it('lists in a reused id only the lines of the request request_trace answers', async () => {
    await boot();
    await get('/logged/lines/first?count=1', 'same');
    await get('/logged/lines/second?count=1', 'same');

    const { trace } = await call('request_trace', { id: 'same' });
    expect(messages(trace.logs)).toEqual(['second line 0']);
  });

  it('says logsDropped when the buffer already discarded part of the lines', async () => {
    await boot({ root: { kind: 'sync', options: { logs: { bufferSize: 4 } } } });
    await get('/logged/lines/many?count=10', 'many');

    const { trace } = await call('request_trace', { id: 'many' });
    expect(trace.logsDropped).toBe(true);
    expect(messages(trace.logs)).toEqual([
      'many line 6',
      'many line 7',
      'many line 8',
      'many line 9',
    ]);
  });

  it('caps the lines at 200, the newest, and says logsTruncated', async () => {
    await boot();
    await get('/logged/lines/long?count=250', 'long');

    const { trace } = await call('request_trace', { id: 'long' });
    expect(trace.logs).toHaveLength(200);
    expect(trace.logsTruncated).toBe(true);
    expect(trace.logsDropped).toBeUndefined();
    expect(trace.logs[0].message).toBe('long line 50');
    expect(trace.logs[199].message).toBe('long line 249');
  });

  it('answers logs: [] for a request that logged nothing', async () => {
    await boot();
    await get('/cats', 'quiet');
    const { trace } = await call('request_trace', { id: 'quiet' });
    expect(trace.logs).toEqual([]);
  });

  it('adds no requestId with the requests group off', async () => {
    await boot({ root: { kind: 'sync', options: { tools: { requests: false } } } });
    await get('/logged/lines/untraced?count=1', 'untraced');

    const tail = await call('logs_tail', { contains: 'untraced line' });
    expect(tail.entries).toHaveLength(1);
    expect(Object.keys(tail.entries[0]).sort()).toEqual(
      ['context', 'level', 'message', 'seq', 'source', 'timestamp'].sort(),
    );
  });

  it('adds no logs field to traces with the logs group off', async () => {
    await boot({ root: { kind: 'sync', options: { tools: { logs: false } } } });
    await get('/logged/fail/nologs', 'nologs');

    const { trace } = await call('request_trace', { id: 'nologs' });
    expect(trace).not.toHaveProperty('logs');
    expect(trace).not.toHaveProperty('logsDropped');
    expect(trace).not.toHaveProperty('logsTruncated');
  });
});
