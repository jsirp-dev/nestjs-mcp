import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RunningApp, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ID_HEADER = 'x-nest-mcp-request-id';

/** A step as `kind:name[/phase]:outcome`. */
function shape(step: Json): string {
  return `${step.kind}:${step.name}${step.phase ? `/${step.phase}` : ''}:${step.outcome}`;
}

function multipart(): FormData {
  const form = new FormData();
  form.append('subject', 'x');
  form.append('file', new Blob(['hello']), 'hello.txt');
  return form;
}

describe('a middleware that loses the async context before the route', () => {
  let running: RunningApp;
  let client: Client;

  beforeEach(async () => {
    running = await startApp({ upload: true });
    client = await running.connect('/');
  });

  afterEach(async () => {
    await running.close();
  });

  async function traceOf(id: string): Promise<Json> {
    const result = await client.callTool({ name: 'request_trace', arguments: { id } });
    return (toolJson(result) as Json).trace as Json;
  }

  async function post(path: string, id: string, init: RequestInit): Promise<number> {
    const response = await running.fetch(path, {
      method: 'POST',
      ...init,
      headers: { [ID_HEADER]: id, ...(init.headers as Record<string, string>) },
    });
    await response.text();
    return response.status;
  }

  it('keeps the steps of a multipart request multer parsed, as with a JSON body', async () => {
    expect(await post('/uploads/form', 'form', { body: multipart() })).toBe(201);
    expect(
      await post('/uploads/form', 'json', {
        body: JSON.stringify({ subject: 'x' }),
        headers: { 'content-type': 'application/json' },
      }),
    ).toBe(201);

    const form = await traceOf('form');
    const json = await traceOf('json');
    const steps = [
      'guard:UploadGuard:allowed',
      'interceptor:UploadInterceptor/enter:ok',
      'pipe:UploadPipe:ok',
      'handler:UploadController.form:ok',
      'interceptor:UploadInterceptor/exit:ok',
    ];
    const identity = {
      controller: 'UploadController',
      handler: 'form',
      route: '/uploads/form',
      module: 'UploadModule',
    };
    expect(form.steps.map(shape)).toEqual(steps);
    expect(form).toMatchObject(identity);
    expect(json.steps.map(shape)).toEqual(steps);
    expect(json).toMatchObject(identity);
    // The handler's log line is tied to its request too, with the context multer lost.
    expect(form.logs).toEqual([
      expect.objectContaining({ message: 'form received', requestId: 'form' }),
    ]);
    expect(json.logs).toEqual([
      expect.objectContaining({ message: 'form received', requestId: 'json' }),
    ]);
  });

  it('records the filter that catches an exception of a multipart request', async () => {
    expect(await post('/uploads/missing', 'missing', { body: multipart() })).toBe(404);
    const trace = await traceOf('missing');
    expect(trace.steps.map(shape)).toEqual([
      'guard:UploadGuard:allowed',
      'interceptor:UploadInterceptor/enter:ok',
      'handler:UploadController.missing:threw',
      'interceptor:UploadInterceptor/exit:threw',
      'filter:UploadFilter:caught',
    ]);
  });

  it('stores neither the fields nor the files multer parsed', async () => {
    expect(await post('/uploads/form', 'private', { body: multipart() })).toBe(201);
    const text = JSON.stringify(await traceOf('private'));
    expect(text).not.toContain('hello');
    expect(text).not.toContain('subject');
  });
});

describe("an interceptor's exit phase behind a middleware that loses the async context", () => {
  let running: RunningApp;
  let client: Client;

  beforeEach(async () => {
    running = await startApp({ uploadAfter: true, events: true });
    client = await running.connect('/');
  });

  afterEach(async () => {
    await running.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<Json> {
    return toolJson(await client.callTool({ name, arguments: args })) as Json;
  }

  async function post(id: string, init: RequestInit): Promise<void> {
    const response = await running.fetch('/after', {
      method: 'POST',
      ...init,
      headers: { [ID_HEADER]: id, ...(init.headers as Record<string, string>) },
    });
    await response.text();
    expect(response.status).toBe(201);
  }

  const lines = (logs: Json[]) => logs.map((log) => `${log.context}:${log.message}`);

  it('ties the exit phase and the listener it triggers to a multipart request, as to a JSON one', async () => {
    await post('json-1', {
      body: JSON.stringify({ subject: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    await post('multipart-1', { body: multipart() });

    const expected = [
      'AfterInterceptor:before handle',
      'AfterController:in handler',
      'AfterInterceptor:after handle',
      'AfterListener:listener ran',
    ];
    for (const id of ['json-1', 'multipart-1']) {
      const { trace } = await call('request_trace', { id });
      expect(trace.steps.map(shape)).toEqual([
        'interceptor:AfterInterceptor/enter:ok',
        'handler:AfterController.form:ok',
        'interceptor:AfterInterceptor/exit:ok',
      ]);
      expect(lines(trace.logs)).toEqual(expected);
      expect(trace.logs.every((log: Json) => log.requestId === id)).toBe(true);
    }

    const { runs } = await call('runs_list', { name: 'AfterListener.onDone' });
    expect((runs as Json[]).map((run) => run.requestId).sort()).toEqual(['json-1', 'multipart-1']);
    const { entries } = await call('logs_tail', { context: 'AfterInterceptor' });
    expect((entries as Json[]).map((entry) => `${entry.message}@${entry.requestId}`)).toEqual([
      'before handle@json-1',
      'after handle@json-1',
      'before handle@multipart-1',
      'after handle@multipart-1',
    ]);
  });
});
