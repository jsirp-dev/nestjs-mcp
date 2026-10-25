import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { LOGGER_CONTEXT, NEST_MCP_OPTIONS, NEST_MCP_TOOL_CONTEXT } from './constants.js';
import { installLogs } from './logs/install-logs.js';
import type { ResolvedNestMcpOptions } from './nest-mcp.options.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/tool-context.js';
import { isLoopback, listenerFor, type InspectorListener } from './transport/listener.js';
import { createMcpHandler } from './transport/mcp-endpoint.js';

/**
 * What each instance does over the app's lifecycle: at `onModuleInit`, joins (or installs) the
 * process-wide Logger tee, connects the host's log sink and joins the app's inspector listener with
 * its path; at `onApplicationBootstrap`, opens the listener (the first instance does) and writes the bootstrap
 * log and warnings, once per instance, through Nest's `Logger` (context `NestMcp`); at
 * `onModuleDestroy`, disconnects the sink and leaves the listener, which the last instance closes.
 */
@Injectable()
export class NestMcpBootstrap implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LOGGER_CONTEXT);
  private listener: InspectorListener | undefined;

  constructor(
    @Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions,
    @Inject(NEST_MCP_TOOL_CONTEXT) private readonly context: ToolContext,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    // One per app: the key of the listener every instance of the app shares.
    @Inject(ModulesContainer) private readonly modulesContainer: object,
  ) {}

  /**
   * `useLogger` runs before `init`/`listen` in a normal bootstrap, so the active logger is final
   * here; and every `onApplicationBootstrap` of the app, where apps log the most, comes after.
   * Every instance joins here, so the listener knows all of them before the first one opens it.
   */
  onModuleInit(): void {
    if (!this.options.enabled) return;
    if (this.options.tools.logs) this.context.logs = installLogs(this.options.logs);
    const onError = (message: string) => this.logger.error(message);
    this.listener = listenerFor(this.modulesContainer);
    this.listener.join({
      path: this.options.path,
      authorize: this.options.authorize,
      listen: this.options.listen,
      handle: createMcpHandler(this.registry, this.options.serverInfo, onError),
      onError,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled || !this.listener) return;
    const path = this.context.mcpPath();

    if (!this.context.snapshotEnabled()) {
      this.logger.warn(
        `${path}: the app was created without snapshot: true, so graph and routes tools answer ` +
          'snapshot_disabled. Set it in NestFactory.create(AppModule, { snapshot: true }).',
      );
    }
    const { host } = this.listener.address();
    if (!isLoopback(host) && !this.options.authorize) {
      this.logger.warn(
        `${path}: the inspector listens on ${host}, beyond loopback, with no \`authorize\`. ` +
          'Anyone who reaches that address can inspect the app; add `authorize`.',
      );
    }
    this.context.mcpUrl = `${await this.listener.open()}${path}`;
    this.logger.log(`Inspector listening at ${this.context.mcpUrl}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.context.logs?.uninstall();
    await this.listener?.leave(this.options.path);
    this.listener = undefined;
  }
}
