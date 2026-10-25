import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:net';
import { AppModule } from './fixtures/app/app.module.js';
import { API_KEY, API_KEY_HEADER } from './fixtures/app/cats/api-key.guard.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { CountingGuard } from './fixtures/app/global.guards.js';
import { RecordingLogger, RunningApp, freePort, startApp, toolJson } from './support/start-app.js';

const MCP_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
};

/** Whether something accepts connections on `127.0.0.1:port`. */
async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

describe('inspector listener', () => {
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

  it('listens on 127.0.0.1:7777 with no options, logs it and reports it in app_info', async () => {
    const logger = new RecordingLogger();
    running = await startApp({ logger, inspectorPort: 'default' });
    expect(running.inspectorUrl).toBe('http://127.0.0.1:7777');

    const client = await running.connect('/');

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('app_info');
    expect(logger.from('NestMcp')).toEqual([
      {
        level: 'log',
        message: 'Inspector listening at http://127.0.0.1:7777/',
        context: 'NestMcp',
      },
    ]);
    expect(await appInfo('/')).toMatchObject({ mcpPath: '/', mcpUrl: 'http://127.0.0.1:7777/' });
  });

  it('app_info reports the prefix, versioning, endpoint and scope of the instance', async () => {
    running = await startApp({
      globalPrefix: 'api',
      versioning: { type: VersioningType.URI, defaultVersion: '1' },
    });

    expect(await appInfo('/')).toEqual({
      server: { name: '@jsirp/nestjs-mcp', version: expect.any(String) },
      nest: expect.stringMatching(/^1[01]\.\d+\.\d+/),
      node: process.version,
      uptimeSeconds: expect.any(Number),
      globalPrefix: 'api',
      versioning: { type: 'URI', defaultVersion: '1', prefix: 'v' },
      mcpPath: '/',
      mcpUrl: `${running.inspectorUrl}/`,
      scope: { kind: 'app' },
      snapshot: true,
      tools: {
        graph: true,
        routes: true,
        logs: true,
        requests: true,
        events: false,
        schedule: false,
        runs: false,
      },
      debug: { enabled: false, stackFrames: 30, sourceMaps: { process: false, files: 0 } },
      options: {
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
        debug: { enabled: false, stackFrames: 30 },
      },
    });
  });

  it('serves forRoot at / and forFeature at its path on one listener', async () => {
    running = await startApp({ catsInspector: { path: 'cats' } });

    expect(await appInfo('/')).toMatchObject({
      mcpUrl: `${running.inspectorUrl}/`,
      scope: { kind: 'app' },
    });
    expect(await appInfo('cats')).toMatchObject({
      mcpPath: '/cats',
      mcpUrl: `${running.inspectorUrl}/cats`,
      scope: { kind: 'module', module: 'CatsModule' },
    });
  });

  it('registers no controller: the old path on the app port gets the app 404', async () => {
    running = await startApp({ globalPrefix: 'api' });

    for (const path of ['_mcp', 'api/_mcp', 'api']) {
      const response = await running.fetch(path, MCP_POST);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
    }
    const client = await running.connect('/');
    const { routes } = toolJson(await client.callTool({ name: 'routes_list', arguments: {} })) as {
      routes: Array<{ method: string; handler: string }>;
    };
    expect(routes.map((route) => `${route.method} ${route.handler}`)).toEqual([
      'GET CatsController.findAll',
      'GET CatsController.findOne',
    ]);
  });

  it("runs none of the app's global guards on inspector calls", async () => {
    const guard = new CountingGuard();
    running = await startApp({ globalGuards: [guard] });

    const client = await running.connect('/');
    await client.listTools();
    await client.callTool({ name: 'app_info', arguments: {} });
    const requests = toolJson(await client.callTool({ name: 'requests_list', arguments: {} }));

    expect(guard.calls).toBe(0);
    expect(requests).toMatchObject({ requests: [] });
    // The app's own routes still go through it.
    await running.fetch('cats', { headers: { [API_KEY_HEADER]: API_KEY } });
    expect(guard.calls).toBe(1);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 and Allow: POST', async (method) => {
    running = await startApp();

    const response = await running.inspect('/', { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('answers 404 on a path no instance serves, and ignores the query string', async () => {
    running = await startApp({ catsInspector: true });

    expect((await running.inspect('_mcp', MCP_POST)).status).toBe(404);
    expect((await running.inspect('cats/extra', MCP_POST)).status).toBe(404);
    expect((await running.inspect('cats/?probe=1', MCP_POST)).status).toBe(200);
  });

  it('serves a custom path, with slashes trimmed', async () => {
    running = await startApp({ root: { kind: 'sync', options: { path: '/inspect/' } } });

    expect((await appInfo('inspect')).mcpPath).toBe('/inspect');
    expect((await running.inspect('/', MCP_POST)).status).toBe(404);
  });

  it('picks a free port with listen.port 0 and logs the one it got', async () => {
    const logger = new RecordingLogger();
    const app = await NestFactory.create(
      AppModule.with({ root: { kind: 'sync', options: { listen: { port: 0 } } } }),
      { snapshot: true, logger, abortOnError: false },
    );
    try {
      await app.init();
      const [entry] = logger.from('NestMcp');
      const url = /^Inspector listening at (http:\/\/127\.0\.0\.1:(\d+)\/)$/.exec(entry!.message);
      expect(url).not.toBeNull();
      expect(Number(url![2])).toBeGreaterThan(0);
      expect((await fetch(url![1]!, MCP_POST)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('closes the listener on app.close(), freeing the port', async () => {
    running = await startApp();
    const port = Number(new URL(running.inspectorUrl).port);
    expect(await listening(port)).toBe(true);

    await running.close();
    running = undefined;

    expect(await listening(port)).toBe(false);
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails at startup naming listen.port when the port is in use', async () => {
    const port = await freePort();
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    const app = await NestFactory.create(
      AppModule.with({ inspectorListen: { host: '127.0.0.1', port } }),
      { snapshot: true, logger: new RecordingLogger(), abortOnError: false },
    );
    try {
      await expect(app.init()).rejects.toThrow(/127\.0\.0\.1:\d+.*in use.*`listen\.port`/);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('fails at startup when two instances take the same path', async () => {
    const app = await NestFactory.create(
      AppModule.with({
        root: { kind: 'sync', options: { path: CATS_INSPECTOR_PATH } },
        catsInspector: true,
        inspectorListen: { port: await freePort() },
      }),
      { snapshot: true, logger: new RecordingLogger(), abortOnError: false },
    );
    try {
      await expect(app.init()).rejects.toThrow(/two instances answer at \/cats.*`path`/);
    } finally {
      await app.close();
    }
  });

  it('fails at startup when two instances set different listen options', async () => {
    const app = await NestFactory.create(
      AppModule.with({
        inspectorListen: { port: await freePort() },
        catsInspector: { listen: { port: await freePort() } },
      }),
      { snapshot: true, logger: new RecordingLogger(), abortOnError: false },
    );
    try {
      await expect(app.init()).rejects.toThrow(/different `listen` options/);
    } finally {
      await app.close();
    }
  });

  it('reports serverInfo in the initialize handshake', async () => {
    running = await startApp({
      root: { kind: 'sync', options: { serverInfo: { name: 'cats-app', version: '1.2.3' } } },
    });
    const client = await running.connect('/');

    expect(client.getServerVersion()).toMatchObject({ name: 'cats-app', version: '1.2.3' });
  });

  it('opens no listener when enabled is false, and the app routes keep working', async () => {
    running = await startApp({ root: { kind: 'sync', options: { enabled: false } } });

    expect(await listening(Number(new URL(running.inspectorUrl).port))).toBe(false);
    const cats = await running.fetch('cats', { headers: { [API_KEY_HEADER]: API_KEY } });
    expect(cats.status).toBe(200);
    expect(await cats.json()).toEqual([
      { id: 1, name: 'Tom', owner: 'Ada' },
      { id: 2, name: 'Felix', owner: 'Grace' },
    ]);
  });

  describe('authorize', () => {
    it('answers 403 when authorize returns false, and passes it the raw request', async () => {
      const seen: IncomingMessage[] = [];
      running = await startApp({
        root: {
          kind: 'sync',
          options: {
            authorize: (req) => {
              seen.push(req);
              return req.headers['x-inspector-key'] === 'let-me-in';
            },
          },
        },
      });

      const refused = await running.inspect('/', MCP_POST);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { message: /authorize/ } });
      const allowed = await running.inspect('/', {
        ...MCP_POST,
        headers: { ...MCP_POST.headers, 'x-inspector-key': 'let-me-in' },
      });
      expect(allowed.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[0]?.url).toBe('/');
    });

    it('accepts an async authorize, and refuses when it throws, logging why', async () => {
      const logger = new RecordingLogger();
      running = await startApp({
        logger,
        root: {
          kind: 'sync',
          options: {
            authorize: async (req) => {
              if (req.headers['x-boom']) throw new Error('lookup failed');
              return true;
            },
          },
        },
      });

      expect((await running.inspect('/', MCP_POST)).status).toBe(200);
      const thrown = await running.inspect('/', {
        ...MCP_POST,
        headers: { ...MCP_POST.headers, 'x-boom': '1' },
      });
      expect(thrown.status).toBe(403);
      expect(logger.from('NestMcp').filter((entry) => entry.level === 'error')).toEqual([
        expect.objectContaining({ message: expect.stringContaining('lookup failed') }),
      ]);
    });

    it('applies per instance: one instance can be guarded while another is not', async () => {
      running = await startApp({
        root: { kind: 'sync', options: { authorize: () => false } },
        catsInspector: true,
      });

      expect((await running.inspect('/', MCP_POST)).status).toBe(403);
      expect((await running.inspect(CATS_INSPECTOR_PATH, MCP_POST)).status).toBe(200);
    });
  });

  it('throws when forFeature is called without path', () => {
    expect(() => NestMcpModule.forFeature({} as never)).toThrow(/forFeature requires the `path`/);
    expect(() => NestMcpModule.forFeatureAsync({ useFactory: () => ({}) } as never)).toThrow(
      /forFeature requires the `path`/,
    );
  });

  it('rejects an invalid listen.port', () => {
    const app = NestFactory.create(
      AppModule.with({ root: { kind: 'sync', options: { listen: { port: 70000 } } } }),
      { logger: false, abortOnError: false },
    );
    return expect(app).rejects.toThrow(/`listen\.port` must be an integer from 0 to 65535/);
  });

  it('takes the rest of the options, listen included, from a forRootAsync factory', async () => {
    const port = await freePort();
    running = await startApp({
      inspectorPort: port,
      root: {
        kind: 'async',
        options: {
          path: 'async-mcp',
          useFactory: async () => ({
            listen: { port },
            serverInfo: { name: 'from-factory', version: '9.9.9' },
          }),
        },
      },
    });
    const client = await running.connect('async-mcp');

    expect(client.getServerVersion()).toMatchObject({ name: 'from-factory', version: '9.9.9' });
    const info = toolJson(await client.callTool({ name: 'app_info', arguments: {} }));
    expect(info).toMatchObject({ mcpPath: '/async-mcp', scope: { kind: 'app' } });
  });

  it('opens no listener when a forRootAsync factory disables the instance', async () => {
    running = await startApp({
      root: { kind: 'async', options: { useFactory: () => ({ enabled: false }) } },
    });

    expect(await listening(Number(new URL(running.inspectorUrl).port))).toBe(false);
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

    expect(await listening(Number(new URL(running.inspectorUrl).port))).toBe(false);
    // The options provider is still there, as the plan says, and resolves from the factory.
    expect(factoryRuns).toBe(1);
  });

  describe('bootstrap warnings', () => {
    it('warns when the app was created without snapshot, and app_info says so', async () => {
      const logger = new RecordingLogger();
      running = await startApp({ logger, snapshot: false });

      const warnings = logger.from('NestMcp').filter((entry) => entry.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('NestFactory.create(AppModule, { snapshot: true })');
      expect((await appInfo('/')).snapshot).toBe(false);
    });

    it('warns once when listening beyond loopback without authorize', async () => {
      const logger = new RecordingLogger();
      const port = await freePort();
      running = await startApp({
        logger,
        inspectorPort: port,
        root: { kind: 'sync', options: { listen: { host: '0.0.0.0', port } } },
      });

      const warnings = logger.from('NestMcp').filter((entry) => entry.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('beyond loopback');
      expect(warnings[0]?.message).toContain('`authorize`');
      expect((await running.inspect('/', MCP_POST)).status).toBe(200);
    });

    it('does not warn about the network when authorize protects the endpoint', async () => {
      const logger = new RecordingLogger();
      const port = await freePort();
      running = await startApp({
        logger,
        inspectorPort: port,
        root: {
          kind: 'sync',
          options: { listen: { host: '0.0.0.0', port }, authorize: () => true },
        },
      });

      expect(logger.from('NestMcp').filter((entry) => entry.level === 'warn')).toEqual([]);
    });
  });
});
