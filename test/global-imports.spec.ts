import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { FEATURE_INSPECTOR_PATH } from './fixtures/app/globals.module.js';
import { RunningApp, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

describe('global modules in the graph', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  describe('a forRoot instance', () => {
    let client: Client;

    beforeEach(async () => {
      running = await startApp({ globals: true, events: true, schedule: true });
      client = await running.connect('/');
    });

    it('keeps the links Nest adds to every global module out of imports', async () => {
      const feature = await call(client, 'graph_module', { name: 'FeatureModule' });
      expect(feature.isError).toBe(false);
      expect(feature.json.module.imports).toEqual([]);
      expect(feature.json.module.globals.sort()).toEqual([
        'EventEmitterModule',
        'GlobalAModule',
        'GlobalBModule',
        'ScheduleModule',
      ]);

      const globalA = await call(client, 'graph_module', { name: 'GlobalAModule' });
      expect(globalA.json.module.imports).toEqual(['GlobalBModule']);
      expect(globalA.json.module.globals).not.toContain('GlobalBModule');
      expect(globalA.json.module.globals).not.toContain('GlobalAModule');

      const globalB = await call(client, 'graph_module', { name: 'GlobalBModule' });
      expect(globalB.json.module.imports).toEqual([]);
      expect(globalB.json.module.globals).toContain('GlobalAModule');

      const modules = await call(client, 'graph_modules');
      const summary = modules.json.modules.find((module: Json) => module.name === 'FeatureModule');
      expect(summary.imports).toEqual([]);
    });

    it('counts a global module a module declares as a declared import', async () => {
      const declaring = await call(client, 'graph_module', { name: 'DeclaringModule' });
      expect(declaring.json.module.imports).toEqual(['GlobalBModule']);
      expect(declaring.json.module.globals).not.toContain('GlobalBModule');

      const globalB = await call(client, 'graph_module', { name: 'GlobalBModule' });
      expect(globalB.json.module.importedBy.sort()).toEqual([
        'AppModule',
        'DeclaringModule',
        'GlobalAModule',
      ]);
    });

    it('shows the link to InternalCoreModule among the globals with includeInternal', async () => {
      const feature = await call(client, 'graph_module', {
        name: 'FeatureModule',
        includeInternal: true,
      });
      expect(feature.json.module.imports).toEqual([]);
      expect(feature.json.module.globals).toContain('InternalCoreModule');
    });

    it('reports the forwardRef cycle and no cycle made of global links', async () => {
      const names = (
        await call(client, 'graph_modules', { includeInternal: true })
      ).json.modules.map((module: Json) => module.name);
      const { json, isError } = await call(client, 'graph_cycles');
      expect(isError).toBe(false);
      const modules = json.cycles.filter((cycle: Json) => cycle.kind === 'module');
      expect(modules).toEqual([{ kind: 'module', members: ['LoopAModule', 'LoopBModule'] }]);
      for (const member of modules.flatMap((cycle: Json) => cycle.members)) {
        expect(names).toContain(member);
      }
    });
  });

  describe('a forFeature instance in a module that imports no global', () => {
    it('keeps the global modules it can inject from in its scope', async () => {
      running = await startApp({ globals: true, featureInspector: true });
      const client = await running.connect(FEATURE_INSPECTOR_PATH);

      expect((await call(client, 'app_info')).json.scope).toEqual({
        kind: 'module',
        module: 'FeatureModule',
      });
      const modules = await call(client, 'graph_modules');
      expect(modules.json.modules.map((module: Json) => module.name).sort()).toEqual([
        'FeatureModule',
        'GlobalAModule',
        'GlobalBModule',
      ]);
      const feature = await call(client, 'graph_module', { name: 'FeatureModule' });
      expect(feature.json.module.imports).toEqual([]);
      expect(feature.json.module.globals.sort()).toEqual(['GlobalAModule', 'GlobalBModule']);
    });
  });
});
