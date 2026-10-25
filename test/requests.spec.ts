import { ApplicationConfig, ModulesContainer } from '@nestjs/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { API_KEY, API_KEY_HEADER } from './fixtures/app/cats/api-key.guard.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { OWNER_HEADER } from './fixtures/app/cats/owner.guard.js';
import { GlobalGuard } from './fixtures/app/global.guards.js';
import {
  RecordingLogger,
  RunningApp,
  StartAppOptions,
  startApp,
  toolJson,
} from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ID_HEADER = 'x-nest-mcp-request-id';
const WRAPPED = Symbol.for('nestjs-mcp.wrapped');

/** A step as `kind:name[/phase]:outcome`, the shape every expectation compares. */
function shape(step: Json): string {
  return `${step.kind}:${step.name}${step.phase ? `/${step.phase}` : ''}:${step.outcome}`;
}

const HAPPY = [
  'guard:ApiKeyGuard:allowed',
  'interceptor:TimingInterceptor/enter:ok',
  'pipe:ParseIntPipe:ok',
  'handler:CatsController.findOne:ok',
  'interceptor:TimingInterceptor/exit:ok',
];

const PIPE_FAILURE = [
  'guard:ApiKeyGuard:allowed',
  'interceptor:TimingInterceptor/enter:ok',
  'pipe:ParseIntPipe:threw',
  'interceptor:TimingInterceptor/exit:threw',
];

describe('requests tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}, path = '/'): Promise<Client> {
    running = await startApp(options);
    return running.connect(path);
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  /** Fires a request with the API key and a correlation id, and waits for its whole body. */
  async function send(path: string, id: string, headers: Record<string, string> = {}) {
    const response = await running!.fetch(path, {
      headers: { [API_KEY_HEADER]: API_KEY, [ID_HEADER]: id, ...headers },
    });
    await response.text();
    return response;
  }

  async function traceOf(client: Client, id: string, args: Record<string, unknown> = {}) {
    const { json, isError } = await call(client, 'request_trace', { id, ...args });
    expect(isError).toBe(false);
    return json.trace as Json;
  }

  describe('on the fixture app', () => {
    let client: Client;

    beforeEach(async () => {
      client = await boot({ ownerGuard: true });
    });

    it('lists both tools and reports the group live', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['requests_list', 'request_trace']),
      );
      expect((await call(client, 'app_info')).json.tools.requests).toBe(true);
    });

    it('traces the happy path: guards allowed, interceptor, pipe, handler, 200', async () => {
      expect((await send('/cats/1', 'happy')).status).toBe(200);
      const trace = await traceOf(client, 'happy');

      expect(trace).toMatchObject({
        id: 'happy',
        method: 'GET',
        url: '/cats/1',
        route: '/cats/:id',
        statusCode: 200,
        controller: 'CatsController',
        handler: 'findOne',
        module: 'CatsModule',
      });
      expect(trace.durationMs).toEqual(expect.any(Number));
      expect(trace.inFlight).toBeUndefined();
      expect(trace.steps.map(shape)).toEqual(['guard:OwnerGuard:allowed', ...HAPPY]);
      expect(trace.steps[0]).toMatchObject({ level: 'global' });
      expect(trace.steps[1]).toMatchObject({ level: 'controller' });
      expect(trace.steps[3]).toMatchObject({
        level: 'method',
        param: 'id',
        paramType: 'param',
      });
      for (const step of trace.steps) {
        expect(step.startedAtMs).toBeGreaterThanOrEqual(0);
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
      // The handler starts after the pipe ends, and the interceptor's exit spans both.
      const [, , enter, pipe, handler, exit] = trace.steps;
      expect(handler.startedAtMs).toBeGreaterThanOrEqual(
        pipe.startedAtMs + pipe.durationMs - 0.001,
      );
      expect(exit.startedAtMs).toBe(enter.startedAtMs);
      expect(exit.durationMs).toBeGreaterThanOrEqual(handler.durationMs);
    });

    it('stops at a guard that returns false: denied, 403, no later steps', async () => {
      expect((await send('/cats/1', 'denied', { [OWNER_HEADER]: '99' })).status).toBe(403);
      const trace = await traceOf(client, 'denied');
      expect(trace.statusCode).toBe(403);
      expect(trace.steps.map(shape)).toEqual(['guard:OwnerGuard:denied']);
      // Known from the guard's execution context, though no interceptor ran.
      expect(trace).toMatchObject({ controller: 'CatsController', handler: 'findOne' });
    });

    it('records a guard that throws with its exception', async () => {
      const response = await running!.fetch('/cats/1', { headers: { [ID_HEADER]: 'no-key' } });
      expect(response.status).toBe(401);
      const trace = await traceOf(client, 'no-key');
      expect(trace.steps.map(shape)).toEqual([
        'guard:OwnerGuard:allowed',
        'guard:ApiKeyGuard:threw',
      ]);
      expect(trace.steps[1].error).toEqual({
        name: 'UnauthorizedException',
        message: `Missing or wrong ${API_KEY_HEADER}`,
      });
    });

    it('records the pipe that threw, with no handler step, and the 400', async () => {
      expect((await send('/cats/abc', 'bad-id')).status).toBe(400);
      const trace = await traceOf(client, 'bad-id');
      expect(trace.statusCode).toBe(400);
      expect(trace.steps.map(shape)).toEqual(['guard:OwnerGuard:allowed', ...PIPE_FAILURE]);
      expect(trace.steps[3]).toMatchObject({
        param: 'id',
        error: { name: 'BadRequestException' },
      });
    });

    it('records the exception filter that caught what the handler threw', async () => {
      expect((await send('/cats/999', 'missing')).status).toBe(404);
      const trace = await traceOf(client, 'missing');
      expect(trace.steps.map(shape)).toEqual([
        'guard:OwnerGuard:allowed',
        'guard:ApiKeyGuard:allowed',
        'interceptor:TimingInterceptor/enter:ok',
        'pipe:ParseIntPipe:ok',
        'handler:CatsController.findOne:threw',
        'interceptor:TimingInterceptor/exit:threw',
        'filter:NotFoundFilter:caught',
      ]);
      expect(trace.steps[6]).toMatchObject({
        level: 'controller',
        error: { name: 'NotFoundException', message: 'Cat 999 not found' },
      });
    });

    it('takes the id from the correlation header and never echoes it back', async () => {
      const response = await send('/cats/1', 'echo-check');
      expect(response.headers.get(ID_HEADER)).toBeNull();
      expect([...response.headers.keys()]).not.toContain(ID_HEADER);
      expect((await traceOf(client, 'echo-check')).id).toBe('echo-check');
    });

    it('generates an id when the request carries none', async () => {
      await (await running!.fetch('/cats', { headers: { [API_KEY_HEADER]: API_KEY } })).text();
      const { json } = await call(client, 'requests_list', { path: '/cats' });
      const listed = json.requests.find((request: Json) => request.url === '/cats');
      expect(listed.id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await traceOf(client, listed.id)).handler).toBe('findAll');
    });

    it('keeps ten concurrent requests apart', async () => {
      const ids = Array.from({ length: 10 }, (_, index) => `concurrent-${index}`);
      await Promise.all(
        ids.map((id, index) => send(index % 2 === 0 ? '/cats/1' : '/cats/abc', id)),
      );
      for (const [index, id] of ids.entries()) {
        const trace = await traceOf(client, id);
        expect(trace.url).toBe(index % 2 === 0 ? '/cats/1' : '/cats/abc');
        expect(trace.steps.map(shape)).toEqual([
          'guard:OwnerGuard:allowed',
          ...(index % 2 === 0 ? HAPPY : PIPE_FAILURE),
        ]);
      }
    });

    it('lists the latest requests oldest first, with filters', async () => {
      await send('/cats/1', 'list-1');
      await send('/cats/abc', 'list-2');
      await send('/cats/2', 'list-3');
      const all = (await call(client, 'requests_list')).json;
      expect(all.scope).toEqual({ kind: 'app' });
      expect(all.requests.map((request: Json) => request.id)).toEqual([
        'list-1',
        'list-2',
        'list-3',
      ]);
      expect(all.requests[0]).toEqual({
        id: 'list-1',
        method: 'GET',
        url: '/cats/1',
        startedAt: expect.any(String),
        statusCode: 200,
        durationMs: expect.any(Number),
        handler: 'CatsController.findOne',
        module: 'CatsModule',
        steps: 6,
      });

      const ids = async (args: Record<string, unknown>) =>
        (await call(client, 'requests_list', args)).json.requests.map((r: Json) => r.id);
      expect(await ids({ minStatus: 400 })).toEqual(['list-2']);
      expect(await ids({ status: 200 })).toEqual(['list-1', 'list-3']);
      expect(await ids({ path: '/cats/2' })).toEqual(['list-3']);
      expect(await ids({ method: 'post' })).toEqual([]);
      expect(await ids({ limit: 2 })).toEqual(['list-2', 'list-3']);
      expect((await call(client, 'requests_list', { limit: 2 })).json.matched).toBe(3);
    });

    it('never traces the inspector endpoint', async () => {
      await send('/cats/1', 'not-mcp');
      await call(client, 'app_info');
      const { json } = await call(client, 'requests_list');
      expect(json.requests.map((request: Json) => request.url)).toEqual(['/cats/1']);
    });

    it('answers not_found for an unknown id', async () => {
      const { json, isError } = await call(client, 'request_trace', { id: 'nope' });
      expect(isError).toBe(true);
      expect(json).toMatchObject({ error: 'not_found', scope: { kind: 'app' } });
    });
  });

  describe('the headers option', () => {
    async function headersOf(mode: 'none' | 'names' | 'full' | undefined) {
      const client = await boot({
        root: { kind: 'sync', options: mode ? { requests: { headers: mode } } : undefined },
      });
      const response = await running!.fetch('/cats', {
        method: 'POST',
        headers: {
          [ID_HEADER]: 'with-body',
          [API_KEY_HEADER]: API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ secret: 'body-secret-value' }),
      });
      await response.text();
      const trace = await traceOf(client, 'with-body');
      expect(JSON.stringify(trace)).not.toContain('body-secret-value');
      return trace.headers;
    }

    it("'names' (the default) keeps the header names only", async () => {
      const headers = await headersOf(undefined);
      expect(headers).toEqual(expect.arrayContaining([API_KEY_HEADER, 'content-type', ID_HEADER]));
      expect(JSON.stringify(headers)).not.toContain(API_KEY);
    });

    it("'full' keeps names and values", async () => {
      expect(await headersOf('full')).toMatchObject({
        [API_KEY_HEADER]: API_KEY,
        'content-type': 'application/json',
      });
    });

    it("'none' keeps no headers", async () => {
      expect(await headersOf('none')).toBeUndefined();
    });
  });

  describe('scope', () => {
    it('a forFeature instance lists only traces whose handler is in its scope', async () => {
      const root = await boot({ catsInspector: true, health: true });
      const cats = await running!.connect(CATS_INSPECTOR_PATH);
      await send('/cats/1', 'in-scope');
      await send('/health', 'out-of-scope');

      const listed = (await call(cats, 'requests_list')).json;
      expect(listed.scope).toEqual({ kind: 'module', module: 'CatsModule' });
      expect(listed.requests.map((request: Json) => request.id)).toEqual(['in-scope']);
      const outside = await call(cats, 'request_trace', { id: 'out-of-scope' });
      expect(outside.isError).toBe(true);
      expect(outside.json.error).toBe('not_found');
      expect((await traceOf(cats, 'out-of-scope', { scope: 'app' })).module).toBe('HealthModule');

      // Both instances read one buffer, and each request is traced once.
      const all = (await call(root, 'requests_list')).json.requests;
      expect(all.map((request: Json) => request.id)).toEqual(['in-scope', 'out-of-scope']);
      expect((await traceOf(root, 'in-scope')).steps.map(shape)).toEqual(HAPPY);
    });
  });

  it('names levels with a global prefix and a useGlobalGuards instance, without warnings', async () => {
    const logger = new RecordingLogger();
    const client = await boot({ globalPrefix: 'api', globalGuards: [new GlobalGuard()], logger });
    await send('/api/cats/1', 'prefixed');
    const trace = await traceOf(client, 'prefixed');
    expect(trace).toMatchObject({ route: '/api/cats/:id', url: '/api/cats/1', statusCode: 200 });
    expect(trace.steps.map(shape)).toEqual(['guard:GlobalGuard:allowed', ...HAPPY]);
    expect(trace.steps[0].level).toBe('global');
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('reports request-scoped enhancers as not traced', async () => {
    const client = await boot({ requestScoped: true });
    await send('/cats/1', 'scoped');
    const trace = await traceOf(client, 'scoped');
    expect(trace.steps.map(shape)).toEqual(HAPPY);
    expect(trace.notTraced).toEqual(['RequestScopedInterceptor']);
  });

  it('a wrapped guard with an injected dependency answers exactly as unwrapped', async () => {
    const requests: Array<[string, Record<string, string>]> = [
      ['/cats/1', {}],
      ['/cats/1', { [OWNER_HEADER]: '1' }],
      ['/cats/1', { [OWNER_HEADER]: '99' }],
      ['/cats/abc', {}],
      ['/cats/999', {}],
    ];
    const answers = async (requestsOn: boolean) => {
      await boot({
        ownerGuard: true,
        root: { kind: 'sync', options: { tools: { requests: requestsOn } } },
      });
      const seen: Array<[number, string]> = [];
      for (const [path, headers] of requests) {
        const response = await running!.fetch(path, {
          headers: { [API_KEY_HEADER]: API_KEY, [ID_HEADER]: `same-${seen.length}`, ...headers },
        });
        seen.push([response.status, await response.text()]);
      }
      await running!.close();
      running = undefined;
      return seen;
    };
    const unwrapped = await answers(false);
    const wrapped = await answers(true);
    expect(wrapped).toEqual(unwrapped);
    expect(unwrapped.map(([status]) => status)).toEqual([200, 200, 403, 400, 404]);
  });

  describe('matched to their route like route_get names it', () => {
    let client: Client;

    beforeEach(async () => {
      client = await boot({ wrapped: true });
    });

    it('names a handler a decorator replaced by its property key, with module, levels and notTraced', async () => {
      expect((await send('/wrapped/wrapped', 'wrapped')).status).toBe(200);
      const trace = await traceOf(client, 'wrapped');
      expect(trace).toMatchObject({
        controller: 'WrappedController',
        handler: 'wrapped',
        route: '/wrapped/wrapped',
        module: 'WrappedModule',
        notTraced: ['WrappedScopedInterceptor'],
      });
      expect(trace.steps.map(shape)).toEqual([
        'guard:WrappedGuard:allowed',
        'handler:WrappedController.wrapped:ok',
      ]);
      expect(trace.steps[0].level).toBe('controller');

      const { json } = await call(client, 'requests_list');
      expect(json.requests.find((request: Json) => request.id === 'wrapped')).toMatchObject({
        handler: 'WrappedController.wrapped',
        module: 'WrappedModule',
      });
    });

    it('names an inherited wrapped handler by its key on each controller that runs it', async () => {
      await send('/derived-a/inherited', 'derived-a');
      await send('/derived-b/inherited', 'derived-b');
      await send('/derived-a/inherited', 'derived-a-again');
      for (const [id, controller] of [
        ['derived-a', 'DerivedAController'],
        ['derived-b', 'DerivedBController'],
        ['derived-a-again', 'DerivedAController'],
      ]) {
        const trace = await traceOf(client, id!);
        expect(trace).toMatchObject({ controller, handler: 'inherited', module: 'WrappedModule' });
        expect(trace.steps.map(shape)).toEqual([`handler:${controller}.inherited:ok`]);
      }
    });

    it('gives the pipe of an unnamed argument the param route_get shows, and its level', async () => {
      expect((await send('/wrapped/piped/abc', 'piped')).status).toBe(200);
      const { json: route } = await call(client, 'route_get', {
        method: 'GET',
        path: '/wrapped/piped/:id',
      });
      expect(route.route.pipes).toEqual([{ name: 'UpperPipe', level: 'method', param: '#0' }]);

      const trace = await traceOf(client, 'piped');
      expect(trace.steps.find((step: Json) => step.kind === 'pipe')).toMatchObject({
        name: 'UpperPipe',
        param: '#0',
        paramType: 'param',
        level: 'method',
        outcome: 'ok',
      });
    });
  });

  describe('with tools.requests off', () => {
    function marked(app: RunningApp['app']): string[] {
      const found: string[] = [];
      const check = (value: unknown) => {
        if ((value as Record<symbol, unknown> | null)?.[WRAPPED] === true) {
          found.push((value as object).constructor.name);
        }
      };
      for (const module of app.get(ModulesContainer).values()) {
        for (const map of [module.injectables, module.providers, module.controllers]) {
          for (const wrapper of map.values()) check(wrapper.instance);
        }
      }
      const config = app.get(ApplicationConfig);
      for (const value of [
        ...config.getGlobalGuards(),
        ...config.getGlobalInterceptors(),
        ...config.getGlobalPipes(),
        ...config.getGlobalFilters(),
      ]) {
        check(value);
      }
      return found;
    }

    it('wraps nothing, adds no middleware or interceptor and registers no tool', async () => {
      const client = await boot({
        ownerGuard: true,
        root: { kind: 'sync', options: { tools: { requests: false } } },
      });
      expect(marked(running!.app)).toEqual([]);
      expect(running!.app.get(ApplicationConfig).getGlobalInterceptors()).toEqual([]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain('requests_list');
      const route = (await call(client, 'route_get', { method: 'GET', path: '/cats/:id' })).json;
      expect(route.route.middlewares).toEqual([]);
    });

    it('wraps the enhancers when on (the check above can see a mark)', async () => {
      await boot({ ownerGuard: true });
      expect(marked(running!.app)).toEqual(
        expect.arrayContaining([
          'ApiKeyGuard',
          'OwnerGuard',
          'TimingInterceptor',
          'NotFoundFilter',
        ]),
      );
    });
  });
});
