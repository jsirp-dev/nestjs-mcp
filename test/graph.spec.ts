import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { RunningApp, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const GRAPH_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['graph_modules', {}],
  ['graph_module', { name: 'CatsModule' }],
  ['graph_providers', {}],
  ['graph_provider', { token: 'CatsService' }],
  ['graph_cycles', {}],
];

/** Every value in `value` is plain JSON: no functions, symbols, class instances or cycles. */
function plainJsonPaths(value: unknown, path = '$', seen = new Set<unknown>()): string[] {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [];
  if (typeof value !== 'object') return [`${path}: ${typeof value}`];
  if (seen.has(value)) return [`${path}: cycle`];
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return [`${path}: instance of ${proto?.constructor?.name}`];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    plainJsonPaths(item, `${path}.${key}`, seen),
  );
}

describe('graph tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  describe('with snapshot: true', () => {
    let client: Client;

    beforeEach(async () => {
      running = await startApp();
      client = await running.connect('_mcp');
    });

    it('lists the five graph tools and reports the group live', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(GRAPH_TOOLS.map(([name]) => name)),
      );
      expect((await call(client, 'app_info')).json.tools.graph).toBe(true);
    });

    it('lists the modules without Nest internals unless asked for', async () => {
      const { json } = await call(client, 'graph_modules');
      const names = json.modules.map((module: Json) => module.name);

      expect(json.scope).toEqual({ kind: 'app' });
      expect(names).toEqual(
        expect.arrayContaining(['AppModule', 'CatsModule', 'OwnersModule', 'NestMcpModule']),
      );
      expect(names).not.toContain('InternalCoreModule');
      expect(json.modules.find((module: Json) => module.name === 'CatsModule')).toEqual({
        name: 'CatsModule',
        global: false,
        dynamic: true,
        providers: 1,
        controllers: 1,
        imports: ['OwnersModule'],
      });

      const internal = await call(client, 'graph_modules', { includeInternal: true });
      const cats = internal.json.modules.find((module: Json) => module.name === 'CatsModule');
      expect(internal.json.modules.map((module: Json) => module.name)).toContain(
        'InternalCoreModule',
      );
      expect(cats.imports).toEqual(expect.arrayContaining(['InternalCoreModule', 'OwnersModule']));
    });

    it('describes one module: imports, exports, providers, controllers and importers', async () => {
      const cats = await call(client, 'graph_module', { name: 'CatsModule' });
      expect(cats.isError).toBe(false);
      expect(cats.json).toEqual({
        scope: { kind: 'app' },
        module: {
          name: 'CatsModule',
          global: false,
          dynamic: true,
          imports: ['OwnersModule'],
          exports: [],
          providers: [{ token: 'CatsService', scope: 'DEFAULT', exported: false }],
          controllers: ['CatsController'],
          importedBy: ['AppModule'],
        },
      });

      const owners = await call(client, 'graph_module', { name: 'OwnersModule' });
      expect(owners.json.module).toMatchObject({
        exports: ['OwnersService'],
        providers: [{ token: 'OwnersService', scope: 'DEFAULT', exported: true }],
        importedBy: ['CatsModule'],
      });
    });

    it('answers not_found for an unknown module, with similar names', async () => {
      const { json, isError } = await call(client, 'graph_module', { name: 'CatModule' });
      expect(isError).toBe(true);
      expect(json.error).toBe('not_found');
      expect(json.candidates[0]).toBe('CatsModule');
    });

    it('filters providers by substring, module and scope', async () => {
      const all = await call(client, 'graph_providers');
      const tokens = all.json.providers.map((provider: Json) => provider.token);
      expect(tokens).toEqual(expect.arrayContaining(['CatsService', 'OwnersService']));
      expect(tokens).not.toContain('ModuleRef');
      expect(tokens).not.toContain('CatsController');

      const filtered = await call(client, 'graph_providers', { filter: 'service' });
      expect(filtered.json.providers.map((provider: Json) => provider.token).sort()).toEqual([
        'CatsService',
        'OwnersService',
      ]);

      const inOwners = await call(client, 'graph_providers', { module: 'OwnersModule' });
      expect(inOwners.json.providers).toEqual([
        expect.objectContaining({ token: 'OwnersService', module: 'OwnersModule' }),
      ]);

      const request = await call(client, 'graph_providers', { scope: 'REQUEST' });
      expect(request.json.providers).toEqual([]);

      const internal = await call(client, 'graph_providers', {
        filter: 'ModuleRef',
        includeInternal: true,
      });
      expect(internal.json.providers.length).toBeGreaterThan(0);
    });

    it('marks enhancers as injectables with their subtype', async () => {
      const { json } = await call(client, 'graph_providers', { filter: 'ApiKeyGuard' });
      expect(json.providers).toEqual([
        expect.objectContaining({
          token: 'ApiKeyGuard',
          kind: 'injectable',
          subtype: 'guard',
          module: 'CatsModule',
        }),
      ]);
    });

    it('describes one provider with what it depends on and who depends on it', async () => {
      const { json, isError } = await call(client, 'graph_provider', { token: 'CatsService' });
      expect(isError).toBe(false);
      expect(json.scope).toEqual({ kind: 'app' });
      expect(json.provider).toEqual({
        token: 'CatsService',
        kind: 'provider',
        module: 'CatsModule',
        scope: 'DEFAULT',
        durable: false,
        exported: false,
        initTimeMs: expect.any(Number),
        dependsOn: ['OwnersService'],
        dependents: ['CatsController'],
      });
    });

    it('answers not_found for an unknown token, with up to five similar names', async () => {
      const { json, isError } = await call(client, 'graph_provider', { token: 'CatService' });
      expect(isError).toBe(true);
      expect(json.error).toBe('not_found');
      expect(json.candidates[0]).toBe('CatsService');
      expect(json.candidates.length).toBeLessThanOrEqual(5);
    });

    it('answers ambiguous when a token lives in several modules, and module picks one', async () => {
      // Two inspector instances, each with its own NestMcpToolsSetup.
      await running?.close();
      running = await startApp({ catsInspector: true });
      const twoInstances = await running.connect('_mcp');

      const ambiguous = await call(twoInstances, 'graph_provider', { token: 'NestMcpToolsSetup' });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.json.error).toBe('ambiguous');
      expect(ambiguous.json.candidates).toEqual([
        { token: 'NestMcpToolsSetup', module: 'NestMcpModule#1' },
        { token: 'NestMcpToolsSetup', module: 'NestMcpModule#2' },
      ]);

      const picked = await call(twoInstances, 'graph_provider', {
        token: 'NestMcpToolsSetup',
        module: 'NestMcpModule#2',
      });
      expect(picked.isError).toBe(false);
      expect(picked.json.provider.module).toBe('NestMcpModule#2');
    });

    it('reports symbol tokens by their description', async () => {
      const { json } = await call(client, 'graph_providers', { filter: 'NEST_MCP_OPTIONS' });
      expect(json.providers.map((provider: Json) => provider.token)).toContain('NEST_MCP_OPTIONS');
    });

    it('finds no cycles in the fixture app', async () => {
      const { json, isError } = await call(client, 'graph_cycles');
      expect(isError).toBe(false);
      expect(json).toEqual({ scope: { kind: 'app' }, cycles: [] });
    });

    it('never answers instances or functions', async () => {
      for (const [name, args] of GRAPH_TOOLS) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        expect(text).not.toMatch(/\[Function|Symbol\(/);
        expect(plainJsonPaths(JSON.parse(text))).toEqual([]);
      }
    });
  });

  describe('with snapshot: false', () => {
    it('answers snapshot_disabled with isError from every graph tool', async () => {
      running = await startApp({ snapshot: false });
      const client = await running.connect('_mcp');

      expect((await call(client, 'app_info')).json.snapshot).toBe(false);
      for (const [name, args] of GRAPH_TOOLS) {
        const { json, isError } = await call(client, name, args);
        expect({ name, isError, json }).toEqual({
          name,
          isError: true,
          json: {
            error: 'snapshot_disabled',
            hint: 'Pass { snapshot: true } to NestFactory.create',
            scope: { kind: 'app' },
          },
        });
      }
    });
  });

  describe('switched off', () => {
    it('registers no graph tool with tools.graph: false', async () => {
      running = await startApp({ root: { kind: 'sync', options: { tools: { graph: false } } } });
      const client = await running.connect('_mcp');
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name.startsWith('graph_'))).toBe(false);
      expect((await call(client, 'app_info')).json.tools.graph).toBe(false);
    });
  });

  describe('a forFeature instance', () => {
    const CATS_SCOPE = { kind: 'module', module: 'CatsModule' };

    it('reports the module that imports it in app_info and every graph answer', async () => {
      running = await startApp({ catsInspector: true });
      const client = await running.connect(CATS_INSPECTOR_PATH);

      expect((await call(client, 'app_info')).json.scope).toEqual(CATS_SCOPE);
      for (const [name, args] of GRAPH_TOOLS) {
        const { json, isError } = await call(client, name, args);
        expect({ name, isError, scope: json.scope }).toEqual({
          name,
          isError: false,
          scope: CATS_SCOPE,
        });
      }
    });

    it('sees only its closure: the importer and what it imports', async () => {
      running = await startApp({ catsInspector: true });
      const client = await running.connect(CATS_INSPECTOR_PATH);

      const modules = await call(client, 'graph_modules');
      expect(modules.json.modules.map((module: Json) => module.name).sort()).toEqual([
        'CatsModule',
        'OwnersModule',
      ]);
      const internal = await call(client, 'graph_modules', { includeInternal: true });
      expect(internal.json.modules.map((module: Json) => module.name).sort()).toEqual([
        'CatsModule',
        'OwnersModule',
      ]);

      const cats = await call(client, 'graph_module', { name: 'CatsModule' });
      expect(cats.json.module).toMatchObject({ imports: ['OwnersModule'], importedBy: [] });

      const outside = await call(client, 'graph_module', { name: 'AppModule' });
      expect(outside.isError).toBe(true);
      expect(outside.json.error).toBe('not_found');

      const providers = await call(client, 'graph_providers');
      expect(
        [...new Set(providers.json.providers.map((provider: Json) => provider.module))].sort(),
      ).toEqual(['CatsModule', 'OwnersModule']);

      // Unambiguous here: the other instance's NestMcpToolsSetup is out of scope.
      const own = await call(client, 'graph_provider', { token: 'NestMcpToolsSetup' });
      expect(own.json.error).toBe('not_found');

      const service = await call(client, 'graph_provider', { token: 'CatsService' });
      expect(service.json.provider).toMatchObject({
        dependsOn: ['OwnersService'],
        dependents: ['CatsController'],
      });
    });

    it('leaves the forRoot instance of the same app on app scope, seeing every module', async () => {
      running = await startApp({ catsInspector: true });
      const client = await running.connect('_mcp');

      expect((await call(client, 'app_info')).json.scope).toEqual({ kind: 'app' });
      const { json } = await call(client, 'graph_modules');
      expect(json.scope).toEqual({ kind: 'app' });
      expect(json.modules.map((module: Json) => module.name).sort()).toEqual([
        'AppModule',
        'CatsModule',
        'NestMcpModule#1',
        'NestMcpModule#2',
        'OwnersModule',
      ]);
    });

    it('answers scope_unresolved without snapshot, and nothing crashes', async () => {
      running = await startApp({ catsInspector: true, snapshot: false });
      const client = await running.connect(CATS_INSPECTOR_PATH);
      const unresolved = {
        kind: 'module',
        module: null,
        error: 'scope_unresolved',
        fallback: 'app',
      };

      const info = await call(client, 'app_info');
      expect(info.isError).toBe(false);
      expect(info.json.scope).toEqual(unresolved);
      for (const [name, args] of GRAPH_TOOLS) {
        const { json, isError } = await call(client, name, args);
        expect({ name, isError, json }).toEqual({
          name,
          isError: true,
          json: {
            error: 'snapshot_disabled',
            hint: 'Pass { snapshot: true } to NestFactory.create',
            scope: unresolved,
          },
        });
      }
      expect((await running.fetch('/cats')).status).toBeLessThan(500);
    });
  });
});
