import { RequestMethod, VersioningType } from '@nestjs/common';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { GlobalGuard } from './fixtures/app/global.guards.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const FIND_ONE_CHAIN = {
  controller: 'CatsController',
  handler: 'findOne',
  module: 'CatsModule',
  guards: [{ name: 'ApiKeyGuard', level: 'controller' }],
  interceptors: [{ name: 'TimingInterceptor', level: 'controller' }],
  pipes: [{ name: 'ParseIntPipe', level: 'method', param: 'id' }],
  filters: [{ name: 'NotFoundFilter', level: 'controller' }],
};

describe('routes tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions, path = '/'): Promise<Client> {
    running = await startApp(options);
    return running.connect(path);
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  describe('with a global prefix, without versioning', () => {
    let client: Client;

    beforeEach(async () => {
      client = await boot({ globalPrefix: 'api' });
    });

    it('lists both tools and reports the group live', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['routes_list', 'route_get']),
      );
      expect((await call(client, 'app_info')).json.tools.routes).toBe(true);
    });

    it('answers the full enhancer chain of GET /api/cats/:id', async () => {
      const { json, isError } = await call(client, 'route_get', {
        method: 'GET',
        path: '/api/cats/:id',
      });
      expect(isError).toBe(false);
      expect(json).toEqual({
        scope: { kind: 'app' },
        route: {
          method: 'GET',
          path: '/api/cats/:id',
          rawPath: '/cats/:id',
          ...FIND_ONE_CHAIN,
          middlewares: [],
        },
        middlewaresMatch: 'approximate',
      });
    });

    it('accepts the raw path, a lower-case method and a trailing slash', async () => {
      const { json } = await call(client, 'route_get', { method: 'get', path: 'cats/:id/' });
      expect(json.route.path).toBe('/api/cats/:id');
    });

    it('answers not_found with close candidates', async () => {
      const { json, isError } = await call(client, 'route_get', {
        method: 'GET',
        path: '/api/cat/:id',
      });
      expect(isError).toBe(true);
      expect(json.error).toBe('not_found');
      expect(json.candidates).toContain('GET /api/cats/:id');
    });

    it("lists only the app's routes, never the inspector's, and filters them", async () => {
      const all = (await call(client, 'routes_list')).json.routes as Json[];
      expect(all).toEqual([
        expect.objectContaining({ method: 'GET', path: '/api/cats' }),
        {
          method: 'GET',
          path: '/api/cats/:id',
          handler: 'CatsController.findOne',
          guards: 1,
          interceptors: 1,
          pipes: 1,
          filters: 1,
        },
      ]);

      const cats = (await call(client, 'routes_list', { filter: 'cats/:' })).json.routes as Json[];
      expect(cats.map((route) => `${route.method} ${route.path}`)).toEqual(['GET /api/cats/:id']);
    });

    it('filters by method, controller and module', async () => {
      const paths = async (args: Record<string, unknown>) =>
        ((await call(client, 'routes_list', args)).json.routes as Json[]).map(
          (route) => `${route.method} ${route.path}`,
        );
      expect(await paths({ method: 'post' })).toEqual([]);
      expect(await paths({ controller: 'CatsController' })).toEqual([
        'GET /api/cats',
        'GET /api/cats/:id',
      ]);
      expect(await paths({ module: 'OwnersModule' })).toEqual([]);
    });
  });

  describe('with URI versioning', () => {
    it('includes the version in the full path and serialises VERSION_NEUTRAL as neutral', async () => {
      const client = await boot({
        globalPrefix: 'api',
        versioning: { type: VersioningType.URI, defaultVersion: '1' },
      });
      const findOne = (await call(client, 'route_get', { method: 'GET', path: '/api/v1/cats/:id' }))
        .json.route;
      expect(findOne).toEqual({
        method: 'GET',
        path: '/api/v1/cats/:id',
        rawPath: '/cats/:id',
        version: '1',
        ...FIND_ONE_CHAIN,
        middlewares: [],
      });
      expect(
        (await call(client, 'route_get', { method: 'GET', path: '/cats/:id' })).json.route.path,
      ).toBe('/api/v1/cats/:id');
    });
  });

  it('honours the global prefix exclude list', async () => {
    const client = await boot({
      globalPrefix: 'api',
      globalPrefixOptions: { exclude: [{ path: 'cats', method: RequestMethod.GET }] },
    });
    const paths = (
      (await call(client, 'routes_list', { filter: 'cats' })).json.routes as Json[]
    ).map((route) => route.path);
    expect(paths).toEqual(['/cats', '/api/cats/:id']);
    const findAll = (await call(client, 'route_get', { method: 'GET', path: '/cats' })).json.route;
    expect(findAll).toMatchObject({ path: '/cats', rawPath: '/cats', handler: 'findAll' });
  });

  it('lists useGlobalGuards and APP_GUARD guards as global, before the controller ones', async () => {
    const client = await boot({ appGuard: true, globalGuards: [new GlobalGuard()] });
    const { route } = (await call(client, 'route_get', { method: 'GET', path: '/cats/:id' })).json;
    expect(route.guards).toEqual([
      { name: 'AppGuard', level: 'global' },
      { name: 'GlobalGuard', level: 'global' },
      { name: 'ApiKeyGuard', level: 'controller' },
    ]);
  });

  it('lists the middlewares whose forRoutes path matches', async () => {
    const client = await boot({ middleware: true, health: true });
    const route = async (path: string) =>
      (await call(client, 'route_get', { method: 'GET', path })).json.route as Json;
    expect((await route('/cats/:id')).middlewares).toEqual(['TraceMiddleware']);
    expect((await route('/cats')).middlewares).toEqual(['TraceMiddleware']);
    expect(
      (await call(client, 'route_get', { method: 'GET', path: '/health' })).json.route.middlewares,
    ).toEqual([]);
  });

  it('marks function middlewares instead of naming them by the random token Nest gives them', async () => {
    const client = await boot({ middleware: true, functionalMiddleware: true });
    const route = async (path: string) =>
      (await call(client, 'route_get', { method: 'GET', path })).json.route as Json;
    // An arrow function and a named one (`stampRequest`): Nest keeps neither name.
    expect((await route('/cats/:id')).middlewares.sort()).toEqual([
      '<functional middleware from FunctionalMiddlewareModule>',
      '<functional middleware from FunctionalMiddlewareModule>',
      'TraceMiddleware',
    ]);
  });

  it("marks nestjs-pino's two function middlewares as functional, from its LoggerModule", async () => {
    const client = await boot({ pino: true });
    const { route } = (await call(client, 'route_get', { method: 'GET', path: '/cats/:id' })).json;
    expect(route.middlewares).toEqual([
      '<functional middleware from LoggerModule>',
      '<functional middleware from LoggerModule>',
    ]);
  });

  it('matches middlewares by the version of the route they were bound to', async () => {
    const client = await boot({
      middleware: true,
      versioning: { type: VersioningType.URI, defaultVersion: '1' },
    });
    const { route } = (await call(client, 'route_get', { method: 'GET', path: '/v1/cats/:id' }))
      .json;
    expect(route.middlewares).toEqual(['TraceMiddleware']);
  });

  it('lists, in a forFeature instance, only the routes of its scope', async () => {
    const client = await boot({ catsInspector: true, health: true }, CATS_INSPECTOR_PATH);
    const { json } = await call(client, 'routes_list');
    expect(json.scope).toEqual({ kind: 'module', module: 'CatsModule' });
    expect((json.routes as Json[]).map((route) => route.handler)).toEqual([
      'CatsController.findAll',
      'CatsController.findOne',
    ]);
    const outside = await call(client, 'route_get', { method: 'GET', path: '/health' });
    expect(outside.isError).toBe(true);
    expect(outside.json.error).toBe('not_found');
  });

  it('answers snapshot_disabled without snapshot: true', async () => {
    const client = await boot({ snapshot: false });
    for (const [name, args] of [
      ['routes_list', {}],
      ['route_get', { method: 'GET', path: '/cats' }],
    ] as const) {
      const { json, isError } = await call(client, name, args);
      expect(isError).toBe(true);
      expect(json.error).toBe('snapshot_disabled');
    }
  });

  it('registers no routes tools when the group is switched off', async () => {
    const client = await boot({ root: { kind: 'sync', options: { tools: { routes: false } } } });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('routes_list');
    expect((await call(client, 'app_info')).json.tools.routes).toBe(false);
  });
});
