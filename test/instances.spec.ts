import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { RecordingLogger, RunningApp, freePort, startApp, toolJson } from './support/start-app.js';

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

  it('keeps listener, path and authorize apart for two apps booted in one process', async () => {
    const guarded = await start({
      root: { kind: 'sync', options: { path: 'guarded', authorize: () => false } },
    });
    const open = await start({ root: { kind: 'sync', options: { path: 'open' } } });

    expect(guarded.inspectorUrl).not.toBe(open.inspectorUrl);
    expect((await guarded.inspect('guarded', MCP_POST)).status).toBe(403);
    expect((await guarded.inspect('open', MCP_POST)).status).toBe(404);
    expect((await open.inspect('open', MCP_POST)).status).toBe(200);
    expect((await open.inspect('guarded', MCP_POST)).status).toBe(404);
    expect((await appInfo(open, 'open')).mcpPath).toBe('/open');
  });

  describe('app_info options', () => {
    it('reports the resolved tool switches and header policy, with their defaults', async () => {
      const app = await start();

      expect((await appInfo(app, '/')).options).toEqual({
        tools: {
          graph: true,
          routes: true,
          logs: true,
          requests: true,
          events: true,
          schedule: true,
          runs: true,
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

      expect((await appInfo(app, '/')).options).toMatchObject({
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
    it('announces every instance with its URL on the listener and warns nothing by default', async () => {
      const logger = new RecordingLogger();
      const app = await start({ logger, globalPrefix: 'api', catsInspector: true });

      const entries = logger.from('NestMcp');
      expect(entries.filter((entry) => entry.level !== 'log')).toEqual([]);
      expect(entries.map((entry) => entry.message).sort()).toEqual(
        [
          `Inspector listening at ${app.inspectorUrl}/`,
          `Inspector listening at ${app.inspectorUrl}/${CATS_INSPECTOR_PATH}`,
        ].sort(),
      );
    });

    it('warns once per condition and instance when both conditions hold', async () => {
      const logger = new RecordingLogger();
      const port = await freePort();
      await start({
        logger,
        snapshot: false,
        inspectorPort: port,
        root: { kind: 'sync', options: { listen: { host: '0.0.0.0', port } } },
        catsInspector: { authorize: () => true },
      });

      const warnings = logger
        .from('NestMcp')
        .filter((entry) => entry.level === 'warn')
        .map((entry) => entry.message);
      const about = (path: string, text: string) =>
        warnings.filter((message) => message.startsWith(`${path}:`) && message.includes(text));

      expect(warnings).toHaveLength(3);
      expect(about('/', 'snapshot: true')).toHaveLength(1);
      expect(about('/', 'beyond loopback')).toHaveLength(1);
      expect(about(`/${CATS_INSPECTOR_PATH}`, 'snapshot: true')).toHaveLength(1);
    });
  });
});
