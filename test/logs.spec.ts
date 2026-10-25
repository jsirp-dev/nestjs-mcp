import 'reflect-metadata';
import { Controller, Get, Logger, Module, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import { LoggerModule, Logger as PinoLogger } from 'nestjs-pino';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { FIXTURE_STACK } from './fixtures/app/cats/logging.service.js';
import { MemoryLogger, type LoggerCall } from './support/memory-logger.js';
import { RunningApp, StartAppOptions, freePort, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { json: toolJson(result) as Json, isError: result.isError === true };
}

function activeLogger(): unknown {
  return (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
}

const isTee = (value: unknown) =>
  typeof value === 'object' && value !== null && Symbol.for('@jsirp/nestjs-mcp/log-tee') in value;

/** The calls with the ephemeral port taken out, so two boots compare equal. */
function stable(calls: LoggerCall[]): LoggerCall[] {
  return JSON.parse(JSON.stringify(calls).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT'));
}

describe('logs', () => {
  let running: RunningApp | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}) {
    const logger = new MemoryLogger();
    running = await startApp({ logging: true, logger, ...options });
    // The endpoint line is written once the server is listening; let it through.
    await new Promise((resolve) => setImmediate(resolve));
    return { logger, client: await running.connect('/') };
  }

  it('forwards to the app logger exactly what it received without the tee', async () => {
    const without = await boot({ root: { kind: 'sync', options: { tools: { logs: false } } } });
    expect(isTee(activeLogger())).toBe(false);
    await running!.close();
    running = undefined;

    const withTee = await boot();
    expect(isTee(activeLogger())).toBe(true);
    expect(stable(withTee.logger.calls)).toEqual(stable(without.logger.calls));
  });

  it('copies, in the same order, every call the app logger received after bootstrap', async () => {
    const { logger, client } = await boot();
    const { json } = await call(client, 'logs_tail', { limit: 500 });
    const copied = logger.calls.slice(-json.entries.length);
    expect(json.entries.length).toBeGreaterThan(2);
    expect(json.entries.map((entry: Json) => [entry.level, entry.message])).toEqual(
      copied.map((item) => [item.method, String(item.args[0])]),
    );
    expect(json.lastSeq).toBe(json.entries[json.entries.length - 1].seq);
  });

  it("answers the fixture's warn with its context, and its error with the stack", async () => {
    const { client } = await boot();
    const warn = await call(client, 'logs_tail', { level: 'warn' });
    expect(warn.json.scope).toEqual({ kind: 'app' });
    expect(warn.json.entries).toEqual([
      {
        seq: expect.any(Number),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        level: 'warn',
        context: 'LoggingService',
        message: 'Cats are running low on food',
      },
    ]);

    const errors = await call(client, 'logs_tail', { minLevel: 'error' });
    expect(errors.json.entries).toEqual([
      expect.objectContaining({
        level: 'error',
        context: 'LoggingService',
        message: 'Litter box overflow',
        stack: FIXTURE_STACK,
      }),
    ]);

    const byContext = await call(client, 'logs_tail', { context: 'LoggingService' });
    expect(byContext.json.entries.map((entry: Json) => entry.level)).toEqual(['warn', 'error']);
    const byText = await call(client, 'logs_tail', { contains: 'LITTER BOX' });
    expect(byText.json.entries.map((entry: Json) => entry.level)).toEqual(['error']);
    const own = await call(client, 'logs_tail', { context: 'NestMcp' });
    expect(own.json.entries.map((entry: Json) => entry.message)).toEqual([
      expect.stringMatching(/^Inspector listening at http:\/\/127\.0\.0\.1:\d+\/$/),
    ]);
  });

  it('pages with sinceSeq without gaps or duplicates', async () => {
    const { client } = await boot();
    const start = (await call(client, 'logs_tail', { limit: 1 })).json.lastSeq;
    const pager = new Logger('Pager');
    for (let index = 0; index < 7; index++) pager.log(`line ${index}`);

    const seen: string[] = [];
    const seqs: number[] = [];
    let sinceSeq = start;
    for (let page = 0; page < 5; page++) {
      const { json } = await call(client, 'logs_tail', { sinceSeq, limit: 3 });
      seen.push(...json.entries.map((entry: Json) => entry.message));
      seqs.push(...json.entries.map((entry: Json) => entry.seq));
      sinceSeq = json.lastSeq;
      if (!json.more) break;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map((index) => `line ${index}`));
    expect(seqs).toEqual(seqs.map((_, index) => start + 1 + index));

    const after = await call(client, 'logs_tail', { sinceSeq });
    expect(after.json).toMatchObject({ entries: [], lastSeq: sinceSeq, more: false });
  });

  it('keeps only the newest entries when the buffer is full', async () => {
    const { client } = await boot({ root: { kind: 'sync', options: { logs: { bufferSize: 3 } } } });
    const levels = await call(client, 'logs_levels');
    expect(levels.json.buffer).toEqual({ size: 3, length: 3, lastSeq: expect.any(Number) });
    expect(levels.json.buffer.lastSeq).toBeGreaterThan(3);

    const { json } = await call(client, 'logs_tail', { sinceSeq: 0 });
    const last = levels.json.buffer.lastSeq;
    expect(json.entries.map((entry: Json) => entry.seq)).toEqual([last - 2, last - 1, last]);
    expect(json.dropped).toBe(last - 3);
  });

  it('reports the levels the app logger has on, when it can say', async () => {
    class LevelledLogger extends MemoryLogger {
      isLevelEnabled(level: string) {
        return level !== 'verbose' && level !== 'debug';
      }
    }
    const { client } = await boot({ logger: new LevelledLogger() });
    const { json } = await call(client, 'logs_levels');
    expect(json).toEqual({
      scope: { kind: 'app' },
      levels: ['log', 'warn', 'error', 'fatal'],
      buffer: { size: 2000, length: expect.any(Number), lastSeq: expect.any(Number) },
    });
  });

  it('reports null levels for a logger that cannot say', async () => {
    const { client } = await boot();
    expect((await call(client, 'logs_levels')).json.levels).toBeNull();
  });

  describe('with two instances in one app', () => {
    it('shares one buffer and records each entry once', async () => {
      const { logger, client } = await boot({ catsInspector: true });
      const cats = await running!.connect(CATS_INSPECTOR_PATH);
      const fromRoot = await call(client, 'logs_tail', { limit: 500 });
      const fromCats = await call(cats, 'logs_tail', { limit: 500, scope: 'app' });
      expect(fromCats.json.entries).toEqual(fromRoot.json.entries);
      expect(fromCats.json.scope).toEqual({ kind: 'app' });

      const warns = (calls: Json[]) =>
        calls.filter((entry) => entry.message === 'Cats are running low on food');
      expect(warns(fromRoot.json.entries)).toHaveLength(1);
      expect(
        logger.calls.filter((item) => item.args[0] === 'Cats are running low on food'),
      ).toHaveLength(1);
    });

    it('filters a module-scoped instance by the class names in its scope', async () => {
      await boot({ catsInspector: true });
      const cats = await running!.connect(CATS_INSPECTOR_PATH);
      const { json } = await call(cats, 'logs_tail');
      expect(json.scope).toEqual({ kind: 'module', module: 'CatsModule' });
      expect(json.scopeFilter).toBe('context-is-class-in-scope');
      expect(json.entries.map((entry: Json) => [entry.level, entry.context])).toEqual([
        ['warn', 'LoggingService'],
        ['error', 'LoggingService'],
      ]);

      const app = await call(cats, 'logs_tail', { scope: 'app', context: 'NestMcp' });
      expect(app.json.entries.length).toBe(2);
      expect(app.json.scopeFilter).toBeUndefined();
    });
  });

  it('installs nothing and registers no logs tool when the group is off', async () => {
    const logger = new MemoryLogger();
    const { client } = await boot({
      logger,
      root: { kind: 'sync', options: { tools: { logs: false } } },
    });
    expect(activeLogger()).toBe(logger);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('logs_'))).toEqual([]);
    const info = await call(client, 'app_info');
    expect(info.json.tools.logs).toBe(false);
    expect(info.json.options.tools.logs).toBe(false);
  });

  it('is live in app_info when the group is on', async () => {
    const { client } = await boot();
    const info = await call(client, 'app_info');
    expect(info.json.tools.logs).toBe(true);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['logs_tail', 'logs_levels']),
    );
  });
});

describe('logs with nestjs-pino', () => {
  @Controller('ping')
  class PingController {
    private readonly logger = new Logger(PingController.name);

    @Get()
    ping(): string {
      this.logger.log('pong through Logger');
      return 'pong';
    }
  }

  it("captures what goes through Nest's Logger and not what pino-http writes", async () => {
    const lines: Json[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });

    const inspectorPort = await freePort();
    @Module({
      imports: [
        LoggerModule.forRoot({ pinoHttp: [{ level: 'info' }, stream] }),
        NestMcpModule.forRoot({ listen: { port: inspectorPort } }),
      ],
      controllers: [PingController],
    })
    class PinoAppModule {}

    const app = await NestFactory.create(PinoAppModule, {
      snapshot: true,
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(PinoLogger));
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${inspectorPort}/`)),
      );
      expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe('pong');
      const deadline = Date.now() + 2000;
      while (!lines.some((line) => line.msg === 'request completed') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Both reach pino: one through Nest's Logger, one written by pino-http itself.
      expect(lines.map((line) => line.msg)).toEqual(
        expect.arrayContaining(['pong through Logger', 'request completed']),
      );
      const { json } = await call(client, 'logs_tail', { limit: 500 });
      const messages = json.entries.map((entry: Json) => entry.message);
      expect(messages).toContain('pong through Logger');
      expect(messages).not.toContain('request completed');
      expect(
        json.entries.find((entry: Json) => entry.message === 'pong through Logger').context,
      ).toBe('PingController');
    } finally {
      await client.close();
      await app.close();
    }
  });
});
