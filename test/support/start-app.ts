import 'reflect-metadata';
import { CanActivate, INestApplication, LoggerService, VersioningOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AddressInfo } from 'node:net';
import { AppModule, FixtureAppOptions } from '../fixtures/app/app.module.js';
import { freePort } from './free-port.js';
import { MemoryLogger } from './memory-logger.js';

export { freePort };

export interface StartAppOptions extends FixtureAppOptions {
  /** `snapshot` for `NestFactory.create`. Defaults to `true`. */
  snapshot?: boolean;
  globalPrefix?: string;
  /** Options of `setGlobalPrefix`, such as `exclude`. */
  globalPrefixOptions?: Parameters<INestApplication['setGlobalPrefix']>[1];
  /** Instances passed to `app.useGlobalGuards`. */
  globalGuards?: CanActivate[];
  versioning?: VersioningOptions;
  /** Where Nest logs go. Defaults to a `RecordingLogger`, which records and prints nothing. */
  logger?: LoggerService;
  /**
   * The inspector listener's port: by default a free one the harness picks; `'default'` leaves
   * `listen` unset, so the package's default (`127.0.0.1:7777`) applies.
   */
  inspectorPort?: number | 'default';
}

export interface RunningApp {
  app: INestApplication;
  /** The app's own server: `http://127.0.0.1:<port>` */
  baseUrl: string;
  url(path: string): string;
  /** A request to the app's own server. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The inspector listener: `http://127.0.0.1:<port>` */
  inspectorUrl: string;
  /** A request to the inspector listener. */
  inspect(path: string, init?: RequestInit): Promise<Response>;
  /** An SDK client connected over Streamable HTTP to `path` on the inspector listener. */
  connect(path: string): Promise<Client>;
  close(): Promise<void>;
}

export interface LogEntry {
  level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  message: string;
  context: string | undefined;
}

/**
 * The harness's default logger: a `MemoryLogger` (every call as it arrived) that also keeps each
 * entry by level, message and context, so tests can assert on bootstrap warnings.
 */
export class RecordingLogger extends MemoryLogger {
  readonly entries: LogEntry[] = [];
  override log(message: unknown, ...params: unknown[]) {
    super.log(message, ...params);
    this.record('log', message, params);
  }
  override error(message: unknown, ...params: unknown[]) {
    super.error(message, ...params);
    this.record('error', message, params);
  }
  override warn(message: unknown, ...params: unknown[]) {
    super.warn(message, ...params);
    this.record('warn', message, params);
  }
  override debug(message: unknown, ...params: unknown[]) {
    super.debug(message, ...params);
    this.record('debug', message, params);
  }
  override verbose(message: unknown, ...params: unknown[]) {
    super.verbose(message, ...params);
    this.record('verbose', message, params);
  }
  override fatal(message: unknown, ...params: unknown[]) {
    super.fatal(message, ...params);
    this.record('fatal', message, params);
  }
  from(context: string): LogEntry[] {
    return this.entries.filter((entry) => entry.context === context);
  }
  private record(level: LogEntry['level'], message: unknown, params: unknown[]) {
    const last = params[params.length - 1];
    this.entries.push({
      level,
      message: String(message),
      context: typeof last === 'string' ? last : undefined,
    });
  }
}

/** Boots the fixture app on `127.0.0.1` and a free port, and its inspector on another one. */
export async function startApp(options: StartAppOptions = {}): Promise<RunningApp> {
  const inspectorPort =
    options.inspectorPort === 'default' ? 7777 : (options.inspectorPort ?? (await freePort()));
  const inspectorListen =
    options.inspectorPort === 'default' ? undefined : { host: '127.0.0.1', port: inspectorPort };
  const app = await NestFactory.create(AppModule.with({ ...options, inspectorListen }), {
    snapshot: options.snapshot ?? true,
    logger: options.logger ?? new RecordingLogger(),
    abortOnError: false,
  });
  if (options.globalPrefix) app.setGlobalPrefix(options.globalPrefix, options.globalPrefixOptions);
  if (options.globalGuards) app.useGlobalGuards(...options.globalGuards);
  if (options.versioning) app.enableVersioning(options.versioning);
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const url = (path: string) => `${baseUrl}/${path.replace(/^\/+/, '')}`;
  const inspectorUrl = `http://127.0.0.1:${inspectorPort}`;
  const inspected = (path: string) => `${inspectorUrl}/${path.replace(/^\/+/, '')}`;

  return {
    app,
    baseUrl,
    url,
    fetch: (path, init) => fetch(url(path), init),
    inspectorUrl,
    inspect: (path, init) => fetch(inspected(path), init),
    async connect(path) {
      const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(inspected(path))));
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
