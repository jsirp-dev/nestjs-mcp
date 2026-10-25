import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { LOGGER_CONTEXT, NEST_MCP_OPTIONS, NEST_MCP_TOOL_CONTEXT } from './constants.js';
import { installLogTee } from './logs/install-log-tee.js';
import type { ResolvedNestMcpOptions } from './nest-mcp.options.js';
import type { ToolContext } from './tools/tool-context.js';

interface HttpServerLike {
  listening?: boolean;
  address(): AddressInfo | string | null;
  once(event: 'listening', listener: () => void): unknown;
}

function origin(address: AddressInfo | string | null): string | undefined {
  if (!address || typeof address === 'string') return undefined;
  const wildcard = address.address === '::' || address.address === '0.0.0.0';
  const host = wildcard
    ? 'localhost'
    : address.family === 'IPv6' || address.address.includes(':')
      ? `[${address.address}]`
      : address.address;
  return `http://${host}:${address.port}`;
}

/**
 * What each instance does while the app initialises: joins (or installs) the process-wide Logger
 * tee at `onModuleInit`, then the bootstrap warnings, once per instance, through Nest's `Logger`
 * (context `NestMcp`) at `onApplicationBootstrap`.
 */
@Injectable()
export class NestMcpBootstrap implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(
    @Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions,
    @Inject(NEST_MCP_TOOL_CONTEXT) private readonly context: ToolContext,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /**
   * `useLogger` runs before `init`/`listen` in a normal bootstrap, so the active logger is final
   * here; and every `onApplicationBootstrap` of the app, where apps log the most, comes after.
   */
  onModuleInit(): void {
    if (!this.options.enabled || !this.options.tools.logs) return;
    this.context.logTee = installLogTee(this.options.logs.bufferSize);
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    const path = this.context.mcpPath();

    if (!this.context.snapshotEnabled()) {
      this.logger.warn(
        `${path}: the app was created without snapshot: true, so graph and routes tools answer ` +
          'snapshot_disabled. Set it in NestFactory.create(AppModule, { snapshot: true }).',
      );
    }
    if (!this.options.localOnly && this.options.guards.length === 0) {
      this.logger.warn(
        `${path}: the inspector endpoint is open to the network (localOnly: false) with no guards. ` +
          'Anyone who reaches the app can inspect it; add `guards`.',
      );
    }
    this.announce(path);
  }

  private announce(path: string): void {
    const server = this.adapterHost?.httpAdapter?.getHttpServer?.() as HttpServerLike | undefined;
    if (!server || typeof server.address !== 'function') {
      this.logger.log(`Inspector endpoint at ${path}`);
      return;
    }
    const log = () =>
      this.logger.log(`Inspector endpoint at ${origin(server.address()) ?? ''}${path}`);
    if (server.listening) log();
    else server.once('listening', log);
  }
}
