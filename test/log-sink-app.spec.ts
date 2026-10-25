import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NestMcpModule, createLogSink, type LogCapture, type LogSink } from '@jsirp/nestjs-mcp';
import { InjectPinoLogger, LoggerModule, Logger as NestPinoLogger, PinoLogger } from 'nestjs-pino';
import pino from 'pino';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { RunningApp, freePort, startApp, toolJson } from './support/start-app.js';

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

const SECRET_LINE = 'charged card 4242 with token=abc "quoted"  ';

@Injectable()
class BillingService {
  constructor(@InjectPinoLogger(BillingService.name) private readonly logger: PinoLogger) {}

  charge(): void {
    this.logger.info(SECRET_LINE);
    this.logger.warn('card about to expire');
    this.logger.error(new Error('gateway down'), 'charge failed');
  }
}

@Controller('charge')
class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly billing: BillingService) {}

  @Get()
  charge(): string {
    this.logger.log('charge through Logger');
    this.billing.charge();
    return 'charged';
  }
}

interface PinoApp {
  app: INestApplication;
  client: Client;
  /** Every chunk pino wrote to the stand-in for stdout. */
  stdout: string[];
  get(path: string, headers?: Record<string, string>): Promise<string>;
  close(): Promise<void>;
}

/**
 * An app that logs through nestjs-pino, with pino writing to a stand-in for stdout and to the
 * sink (`multistream`), and Nest's `Logger` routed through pino with `useLogger`.
 */
async function bootPino(options: { capture?: LogCapture; sink?: LogSink } = {}): Promise<PinoApp> {
  const sink = options.sink ?? createLogSink();
  const stdout: string[] = [];
  const stdoutStandIn = new Writable({
    write(chunk, _encoding, done) {
      stdout.push(String(chunk));
      done();
    },
  });
  const inspectorPort = await freePort();

  @Module({
    imports: [
      LoggerModule.forRoot({
        pinoHttp: [
          { level: 'debug' },
          pino.multistream([
            { stream: stdoutStandIn, level: 'debug' },
            { stream: sink, level: 'debug' },
          ]),
        ],
      }),
      NestMcpModule.forRoot({
        listen: { port: inspectorPort },
        logs: { sink, ...(options.capture ? { capture: options.capture } : {}) },
      }),
    ],
    controllers: [BillingController],
    providers: [BillingService],
  })
  class PinoAppModule {}

  const app = await NestFactory.create(PinoAppModule, {
    snapshot: true,
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(NestPinoLogger));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${inspectorPort}/`)),
  );
  return {
    app,
    client,
    stdout,
    async get(path, headers = {}) {
      const text = await (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).text();
      const deadline = Date.now() + 2000;
      while (!stdout.some((line) => line.includes('request completed')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return text;
    },
    async close() {
      await client.close();
      await app.close();
    },
  };
}

describe('log sink with pino', () => {
  let running: PinoApp | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("reads what PinoLogger and pino-http write, with level, context and message, as source 'sink'", async () => {
    running = await bootPino({ capture: 'sink' });
    expect(await running.get('/charge')).toBe('charged');

    const { json } = await call(running.client, 'logs_tail', { source: 'sink', limit: 500 });
    const entries: Json[] = json.entries;
    expect(entries.find((entry) => entry.message === SECRET_LINE)).toMatchObject({
      source: 'sink',
      level: 'log',
      context: 'BillingService',
    });
    expect(entries.find((entry) => entry.message === 'card about to expire')).toMatchObject({
      level: 'warn',
      context: 'BillingService',
    });
    const failed = entries.find((entry) => entry.message === 'charge failed');
    expect(failed).toMatchObject({ level: 'error', context: 'BillingService' });
    expect(failed.stack).toContain('Error: gateway down');
    expect(entries.find((entry) => entry.message === 'request completed')).toMatchObject({
      source: 'sink',
      level: 'log',
    });
  });

  it('leaves stdout exactly as pino wrote it: one sink entry per line, the message intact', async () => {
    running = await bootPino({ capture: 'sink' });
    await running.get('/charge');

    const lines = running.stdout.flatMap((chunk) => chunk.split('\n').filter(Boolean));
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.map((line) => line.msg)).toContain(SECRET_LINE);
    expect(lines.find((line) => line.includes('charged card'))).toContain(
      JSON.stringify(SECRET_LINE),
    );

    const { json } = await call(running.client, 'logs_tail', { limit: 500 });
    // The inspector's answers do not log through pino, so the buffer mirrors stdout line by line.
    expect(json.entries.map((entry: Json) => entry.message)).toEqual(
      parsed.map((line) => line.msg),
    );
  });

  it("with capture 'sink', installs no tee and holds each Nest Logger line once", async () => {
    running = await bootPino({ capture: 'sink' });
    await running.get('/charge');
    expect(isTee(activeLogger())).toBe(false);

    const { json } = await call(running.client, 'logs_tail', {
      contains: 'charge through Logger',
    });
    expect(json.entries).toEqual([
      expect.objectContaining({ source: 'sink', context: 'BillingController', level: 'log' }),
    ]);
    const levels = await call(running.client, 'logs_levels');
    expect(levels.json).toMatchObject({
      capture: 'sink',
      levels: null,
      sink: { connected: true, errors: 0 },
    });
  });

  it("with capture 'both', keeps both copies, and the source filter tells them apart", async () => {
    running = await bootPino();
    await running.get('/charge');
    expect(isTee(activeLogger())).toBe(true);

    const both = await call(running.client, 'logs_tail', { contains: 'charge through Logger' });
    expect(both.json.entries.map((entry: Json) => entry.source).sort()).toEqual(['nest', 'sink']);
    const nest = await call(running.client, 'logs_tail', {
      contains: 'charge through Logger',
      source: 'nest',
    });
    expect(nest.json.entries).toEqual([
      expect.objectContaining({ source: 'nest', context: 'BillingController' }),
    ]);
    const levels = await call(running.client, 'logs_levels');
    expect(levels.json.capture).toBe('both');
  });

  it('ties the lines pino writes inside a request to it, and leaves lines outside one without', async () => {
    const sink = createLogSink();
    running = await bootPino({ capture: 'sink', sink });
    await running.get('/charge', { 'x-nest-mcp-request-id': 'pino-1' });

    const tail = await call(running.client, 'logs_tail', { source: 'sink', limit: 500 });
    const entries: Json[] = tail.json.entries;
    for (const message of [SECRET_LINE, 'card about to expire', 'charge failed']) {
      expect(entries.find((entry) => entry.message === message)).toMatchObject({
        requestId: 'pino-1',
      });
    }
    // A pino line written outside any request, as at bootstrap.
    sink.write(`${JSON.stringify({ level: 30, msg: 'outside a request', context: 'Boot' })}\n`);
    const outside = await call(running.client, 'logs_tail', { context: 'Boot' });
    expect(outside.json.entries).toHaveLength(1);
    expect(outside.json.entries[0]).not.toHaveProperty('requestId');

    const byId = await call(running.client, 'logs_tail', { requestId: 'pino-1' });
    expect(byId.json.entries.map((entry: Json) => entry.message)).toEqual(
      expect.arrayContaining([SECRET_LINE, 'charge failed']),
    );
    const trace = await call(running.client, 'request_trace', { id: 'pino-1' });
    expect(trace.json.trace.logs.map((entry: Json) => entry.message)).toEqual(
      byId.json.entries.map((entry: Json) => entry.message),
    );
  });

  it("with capture 'nest', ignores the sink", async () => {
    running = await bootPino({ capture: 'nest' });
    await running.get('/charge');

    const { json } = await call(running.client, 'logs_tail', { limit: 500 });
    expect(json.entries.every((entry: Json) => entry.source === 'nest')).toBe(true);
    expect(json.entries.map((entry: Json) => entry.message)).toContain('charge through Logger');
    expect(json.entries.map((entry: Json) => entry.message)).not.toContain(SECRET_LINE);
    const levels = await call(running.client, 'logs_levels');
    expect(levels.json).toMatchObject({ capture: 'nest', sink: null });
  });
});

describe('log sink in the fixture app', () => {
  let running: RunningApp | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('captures a winston-style transport that calls record({ level, message, context })', async () => {
    const sink = createLogSink();
    // What a winston transport's `log(info, next)` does with the sink.
    const transport = {
      log(info: Record<string, unknown>, next: () => void) {
        sink.record(info);
        next();
      },
    };
    running = await startApp({ root: { kind: 'sync', options: { logs: { sink } } } });
    const client = await running.connect('/');
    transport.log({ level: 'warn', message: 'disk almost full', context: 'DiskService' }, () => {});
    transport.log({ level: 'info', message: { used: 0.93 }, context: 'DiskService' }, () => {});

    const { json } = await call(client, 'logs_tail', { source: 'sink' });
    expect(json.entries).toEqual([
      expect.objectContaining({
        source: 'sink',
        level: 'warn',
        context: 'DiskService',
        message: 'disk almost full',
      }),
      expect.objectContaining({ level: 'log', message: '{"used":0.93}' }),
    ]);
  });

  it('turns plain text lines into log entries, after what it held before the app started', async () => {
    const sink = createLogSink();
    sink.write('written before the app existed\n');
    running = await startApp({ root: { kind: 'sync', options: { logs: { sink } } } });
    const client = await running.connect('/');
    sink.write('plain text line\nanother one\n');

    const { json } = await call(client, 'logs_tail', { source: 'sink' });
    expect(json.entries.map((entry: Json) => [entry.level, entry.context, entry.message])).toEqual([
      ['log', null, 'written before the app existed'],
      ['log', null, 'plain text line'],
      ['log', null, 'another one'],
    ]);
  });

  it('takes the sink and normalize from a forRootAsync factory', async () => {
    const sink = createLogSink();
    running = await startApp({
      root: {
        kind: 'async',
        options: {
          useFactory: async () => ({
            logs: {
              sink,
              normalize: (record: unknown) => {
                const match = typeof record === 'string' && /^(\w+)\|(\w+)\|(.*)$/.exec(record);
                return match
                  ? { level: match[1], context: match[2], message: match[3] }
                  : undefined;
              },
            },
          }),
        },
      },
    });
    const client = await running.connect('/');
    sink.write('warning|Queue|backlog growing\n');
    sink.write('{"level":50,"msg":"pino still mapped"}\n');

    const { json } = await call(client, 'logs_tail', { source: 'sink' });
    expect(json.entries).toEqual([
      expect.objectContaining({ level: 'warn', context: 'Queue', message: 'backlog growing' }),
      expect.objectContaining({ level: 'error', message: 'pino still mapped' }),
    ]);
  });

  it('swallows what a throwing normalize does and counts it in logs_levels', async () => {
    const sink = createLogSink();
    running = await startApp({
      root: {
        kind: 'sync',
        options: {
          logs: {
            sink,
            normalize: () => {
              throw new Error('bad normalizer');
            },
          },
        },
      },
    });
    const client = await running.connect('/');
    expect(() => sink.write('still recorded\n')).not.toThrow();
    expect(() => sink.record({ level: 'warn', message: 'this too' })).not.toThrow();

    const tail = await call(client, 'logs_tail', { source: 'sink' });
    expect(tail.json.entries.map((entry: Json) => entry.message)).toEqual([
      'still recorded',
      'this too',
    ]);
    const levels = await call(client, 'logs_levels');
    expect(levels.json.sink).toEqual({
      connected: true,
      received: 2,
      errors: 2,
      lastError: 'bad normalizer',
    });
  });

  it('shares one buffer and seq between the tee and the sink', async () => {
    const sink = createLogSink();
    running = await startApp({ root: { kind: 'sync', options: { logs: { sink } } } });
    const client = await running.connect('/');
    new Logger('Mixed').log('from Nest');
    sink.write('from the sink\n');
    new Logger('Mixed').log('from Nest again');

    const { json } = await call(client, 'logs_tail', { contains: 'from' });
    const seqs = json.entries.map((entry: Json) => entry.seq);
    expect(json.entries.map((entry: Json) => [entry.source, entry.message])).toEqual([
      ['nest', 'from Nest'],
      ['sink', 'from the sink'],
      ['nest', 'from Nest again'],
    ]);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('disconnects the sink when the app closes, so a new app reads it afresh', async () => {
    const sink = createLogSink();
    running = await startApp({ root: { kind: 'sync', options: { logs: { sink } } } });
    await running.close();
    sink.write('between apps\n');
    running = await startApp({ root: { kind: 'sync', options: { logs: { sink } } } });
    const client = await running.connect('/');

    const { json } = await call(client, 'logs_tail', { source: 'sink' });
    expect(json.entries.map((entry: Json) => entry.message)).toEqual(['between apps']);
  });

  it.each([
    [{ capture: 'sometimes' }, /logs\.capture/],
    [{ capture: 'sink' }, /needs `logs\.sink`/],
    [{ sink: { write() {} } }, /createLogSink/],
    [{ sink: createLogSink(), normalize: 'yes' }, /logs\.normalize/],
  ])('rejects logs options %p', async (logs, message) => {
    await expect(
      startApp({ root: { kind: 'sync', options: { logs: logs as never } } }),
    ).rejects.toThrow(message);
  });
});
