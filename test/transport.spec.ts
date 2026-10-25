import { VersioningType } from '@nestjs/common';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import { API_KEY, API_KEY_HEADER } from './fixtures/app/cats/api-key.guard.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { DenyAllGuard } from './fixtures/app/deny-all.guard.js';
import { RecordingLogger, RunningApp, startApp, toolJson } from './support/start-app.js';

const MCP_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
};

describe('inspector endpoint', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function appInfo(path: string): Promise<Record<string, unknown>> {
    const client = await running!.connect(path);
    return toolJson(await client.callTool({ name: 'app_info', arguments: {} })) as Record<
      string,
      unknown
    >;
  }

  it('lists app_info over the MCP protocol', async () => {
    running = await startApp();
    const client = await running.connect('_mcp');

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('app_info');
  });

  it('app_info reports the prefix, versioning, endpoint path and scope of the instance', async () => {
    running = await startApp({
      globalPrefix: 'api',
      versioning: { type: VersioningType.URI, defaultVersion: '1' },
    });

    expect(await appInfo('api/_mcp')).toEqual({
      server: { name: '@jsirp/nestjs-mcp', version: expect.any(String) },
      nest: expect.stringMatching(/^1[01]\.\d+\.\d+/),
      node: process.version,
      uptimeSeconds: expect.any(Number),
      globalPrefix: 'api',
      versioning: { type: 'URI', defaultVersion: '1', prefix: 'v' },
      mcpPath: '/api/_mcp',
      scope: { kind: 'app' },
      snapshot: true,
      tools: {
        graph: false,
        routes: false,
        logs: false,
        requests: false,
        events: false,
        schedule: false,
      },
    });
  });

  it('stays version-neutral under URI versioning', async () => {
    running = await startApp({
      globalPrefix: 'api',
      versioning: { type: VersioningType.URI, defaultVersion: '1' },
    });

    expect((await running.fetch('api/v1/_mcp', MCP_POST)).status).toBe(404);
    expect((await running.fetch('api/_mcp', MCP_POST)).status).toBe(200);
    // The app's own routes are versioned as usual.
    const cats = await running.fetch('api/v1/cats', { headers: { [API_KEY_HEADER]: API_KEY } });
    expect(cats.status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 and Allow: POST', async (method) => {
    running = await startApp();

    const response = await running.fetch('_mcp', { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('serves a custom path, with slashes trimmed', async () => {
    running = await startApp({ root: { kind: 'sync', options: { path: '/inspect/' } } });

    expect((await appInfo('inspect')).mcpPath).toBe('/inspect');
    expect((await running.fetch('_mcp', MCP_POST)).status).toBe(404);
  });

  it('reports serverInfo in the initialize handshake', async () => {
    running = await startApp({
      root: { kind: 'sync', options: { serverInfo: { name: 'cats-app', version: '1.2.3' } } },
    });
    const client = await running.connect('_mcp');

    expect(client.getServerVersion()).toMatchObject({ name: 'cats-app', version: '1.2.3' });
  });

  it('registers nothing when enabled is false, and the app routes keep working', async () => {
    running = await startApp({ root: { kind: 'sync', options: { enabled: false } } });

    expect((await running.fetch('_mcp', MCP_POST)).status).toBe(404);
    expect((await running.fetch('_mcp')).status).toBe(404);
    const cats = await running.fetch('cats', { headers: { [API_KEY_HEADER]: API_KEY } });
    expect(cats.status).toBe(200);
    expect(await cats.json()).toEqual([
      { id: 1, name: 'Tom', owner: 'Ada' },
      { id: 2, name: 'Felix', owner: 'Grace' },
    ]);
  });

  it('answers 403 when a configured guard refuses', async () => {
    running = await startApp({ root: { kind: 'sync', options: { guards: [DenyAllGuard] } } });

    const response = await running.fetch('_mcp', MCP_POST);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'Denied by DenyAllGuard' });
  });

  it('runs a forFeature instance on its own path with module scope', async () => {
    running = await startApp({ catsInspector: true });

    const feature = await appInfo(CATS_INSPECTOR_PATH);
    const root = await appInfo('_mcp');

    expect(feature).toMatchObject({
      mcpPath: `/${CATS_INSPECTOR_PATH}`,
      scope: { kind: 'module', module: null },
    });
    expect(root).toMatchObject({ mcpPath: '/_mcp', scope: { kind: 'app' } });
  });

  it('throws when forFeature is called without path', () => {
    expect(() => NestMcpModule.forFeature({} as never)).toThrow(/forFeature requires the `path`/);
    expect(() => NestMcpModule.forFeatureAsync({ useFactory: () => ({}) } as never)).toThrow(
      /forFeature requires the `path`/,
    );
  });

  it('takes the rest of the options from a forRootAsync factory', async () => {
    running = await startApp({
      root: {
        kind: 'async',
        options: {
          path: 'async-mcp',
          useFactory: async () => ({ serverInfo: { name: 'from-factory', version: '9.9.9' } }),
        },
      },
    });
    const client = await running.connect('async-mcp');

    expect(client.getServerVersion()).toMatchObject({ name: 'from-factory', version: '9.9.9' });
    const info = toolJson(await client.callTool({ name: 'app_info', arguments: {} }));
    expect(info).toMatchObject({ mcpPath: '/async-mcp', scope: { kind: 'app' } });
  });

  it('answers 404 when a forRootAsync factory disables the instance', async () => {
    running = await startApp({
      root: { kind: 'async', options: { useFactory: () => ({ enabled: false }) } },
    });

    expect((await running.fetch('_mcp', MCP_POST)).status).toBe(404);
  });

  it('registers nothing when forRootAsync is given a static enabled: false', async () => {
    let factoryRuns = 0;
    running = await startApp({
      root: {
        kind: 'async',
        options: {
          enabled: false,
          useFactory: () => {
            factoryRuns += 1;
            return {};
          },
        },
      },
    });

    expect((await running.fetch('_mcp', MCP_POST)).status).toBe(404);
    expect((await running.fetch('_mcp')).status).toBe(404);
    // The options provider is still there, as the plan says, and resolves from the factory.
    expect(factoryRuns).toBe(1);
  });

  describe('bootstrap warnings', () => {
    it('logs the endpoint URL once', async () => {
      const logger = new RecordingLogger();
      running = await startApp({ logger, globalPrefix: 'api' });

      expect(logger.from('NestMcp')).toEqual([
        {
          level: 'log',
          message: `Inspector endpoint at ${running.baseUrl}/api/_mcp`,
          context: 'NestMcp',
        },
      ]);
    });

    it('warns when the app was created without snapshot, and app_info says so', async () => {
      const logger = new RecordingLogger();
      running = await startApp({ logger, snapshot: false });

      const warnings = logger.from('NestMcp').filter((entry) => entry.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('NestFactory.create(AppModule, { snapshot: true })');
      expect((await appInfo('_mcp')).snapshot).toBe(false);
    });

    it('warns when the endpoint is open to the network without guards', async () => {
      const logger = new RecordingLogger();
      running = await startApp({ logger, root: { kind: 'sync', options: { localOnly: false } } });

      const warnings = logger.from('NestMcp').filter((entry) => entry.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('open to the network');
    });

    it('does not warn about the network when guards protect the endpoint', async () => {
      const logger = new RecordingLogger();
      running = await startApp({
        logger,
        root: { kind: 'sync', options: { localOnly: false, guards: [DenyAllGuard] } },
      });

      expect(logger.from('NestMcp').filter((entry) => entry.level === 'warn')).toEqual([]);
    });
  });
});
