import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { DenyAllGuard } from './fixtures/app/deny-all.guard.js';
import { RecordingLogger, RunningApp, startApp, toolJson } from './support/start-app.js';

const MCP_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
};

describe('inspector instances', () => {
  const running: RunningApp[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((app) => app.close()));
  });

  async function start(...args: Parameters<typeof startApp>): Promise<RunningApp> {
    const app = await startApp(...args);
    running.push(app);
    return app;
  }

  async function appInfo(app: RunningApp, path: string): Promise<Record<string, unknown>> {
    const client = await app.connect(path);
    return toolJson(await client.callTool({ name: 'app_info', arguments: {} })) as Record<
      string,
      unknown
    >;
  }

  it('keeps path and guards apart for two apps booted in one process', async () => {
    const guarded = await start({
      root: { kind: 'sync', options: { path: 'guarded', guards: [DenyAllGuard] } },
    });
    const open = await start({ root: { kind: 'sync', options: { path: 'open' } } });

    expect((await guarded.fetch('guarded', MCP_POST)).status).toBe(403);
    expect((await guarded.fetch('open', MCP_POST)).status).toBe(404);
    expect((await open.fetch('open', MCP_POST)).status).toBe(200);
    expect((await open.fetch('guarded', MCP_POST)).status).toBe(404);
    expect((await appInfo(open, 'open')).mcpPath).toBe('/open');
  });

  describe('app_info options', () => {
    it('reports the resolved tool switches and header policy, with their defaults', async () => {
      const app = await start();

      expect((await appInfo(app, '_mcp')).options).toEqual({
        tools: {
          graph: true,
          routes: true,
          logs: true,
          requests: true,
          events: true,
          schedule: true,
        },
        requests: { headers: 'names' },
      });
    });

    it('reports what each instance was given', async () => {
      const app = await start({
        root: {
          kind: 'async',
          options: {
            useFactory: () => ({ tools: { logs: false }, requests: { headers: 'none' } }),
          },
        },
        catsInspector: true,
      });

      expect((await appInfo(app, '_mcp')).options).toMatchObject({
        tools: { logs: false, graph: true },
        requests: { headers: 'none' },
      });
      expect((await appInfo(app, CATS_INSPECTOR_PATH)).options).toMatchObject({
        tools: { logs: true },
        requests: { headers: 'names' },
      });
    });
  });

  describe('bootstrap log, once per instance', () => {
    it('announces every instance with its full endpoint path and warns nothing by default', async () => {
      const logger = new RecordingLogger();
      const app = await start({ logger, globalPrefix: 'api', catsInspector: true });

      const entries = logger.from('NestMcp');
      expect(entries.filter((entry) => entry.level !== 'log')).toEqual([]);
      expect(entries.map((entry) => entry.message).sort()).toEqual(
        [
          `Inspector endpoint at ${app.baseUrl}/api/_mcp`,
          `Inspector endpoint at ${app.baseUrl}/api/${CATS_INSPECTOR_PATH}`,
        ].sort(),
      );
    });

    it('warns once per condition and instance when both conditions hold', async () => {
      const logger = new RecordingLogger();
      await start({
        logger,
        snapshot: false,
        root: { kind: 'sync', options: { localOnly: false } },
        catsInspector: true,
      });

      const warnings = logger
        .from('NestMcp')
        .filter((entry) => entry.level === 'warn')
        .map((entry) => entry.message);
      const about = (path: string, text: string) =>
        warnings.filter((message) => message.startsWith(`${path}:`) && message.includes(text));

      expect(warnings).toHaveLength(3);
      expect(about('/_mcp', 'snapshot: true')).toHaveLength(1);
      expect(about('/_mcp', 'open to the network')).toHaveLength(1);
      expect(about(`/${CATS_INSPECTOR_PATH}`, 'snapshot: true')).toHaveLength(1);
    });
  });
});
