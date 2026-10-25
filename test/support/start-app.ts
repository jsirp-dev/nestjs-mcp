import 'reflect-metadata';
import { INestApplication, LoggerService, VersioningOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AddressInfo } from 'node:net';
import { AppModule, FixtureAppOptions } from '../fixtures/app/app.module.js';

export interface StartAppOptions extends FixtureAppOptions {
  /** `snapshot` for `NestFactory.create`. Defaults to `true`. */
  snapshot?: boolean;
  globalPrefix?: string;
  versioning?: VersioningOptions;
  /** Where Nest logs go. Defaults to a logger that records and prints nothing. */
  logger?: LoggerService;
}

export interface RunningApp {
  app: INestApplication;
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  url(path: string): string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** An SDK client connected over Streamable HTTP to `path` (relative to the base URL). */
  connect(path: string): Promise<Client>;
  close(): Promise<void>;
}

export interface LogEntry {
  level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  message: string;
  context: string | undefined;
}

/** A `LoggerService` that keeps what Nest logs, so tests can assert on bootstrap warnings. */
export class RecordingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];
  log(message: unknown, context?: string) {
    this.record('log', message, context);
  }
  error(message: unknown, _trace?: string, context?: string) {
    this.record('error', message, context);
  }
  warn(message: unknown, context?: string) {
    this.record('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.record('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.record('verbose', message, context);
  }
  fatal(message: unknown, context?: string) {
    this.record('fatal', message, context);
  }
  from(context: string): LogEntry[] {
    return this.entries.filter((entry) => entry.context === context);
  }
  private record(level: LogEntry['level'], message: unknown, context?: string) {
    this.entries.push({ level, message: String(message), context });
  }
}

/** Boots the fixture app on `127.0.0.1` and a free port. */
export async function startApp(options: StartAppOptions = {}): Promise<RunningApp> {
  const app = await NestFactory.create(AppModule.with(options), {
    snapshot: options.snapshot ?? true,
    logger: options.logger ?? new RecordingLogger(),
    abortOnError: false,
  });
  if (options.globalPrefix) app.setGlobalPrefix(options.globalPrefix);
  if (options.versioning) app.enableVersioning(options.versioning);
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const url = (path: string) => `${baseUrl}/${path.replace(/^\/+/, '')}`;

  return {
    app,
    baseUrl,
    url,
    fetch: (path, init) => fetch(url(path), init),
    async connect(path) {
      const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url(path))));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await app.close();
    },
  };
}

/** The JSON a tool answered, from its single text block. */
export function toolJson(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const [block] = content;
  if (content.length !== 1 || block?.type !== 'text' || block.text === undefined) {
    throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  }
  return JSON.parse(block.text);
}
