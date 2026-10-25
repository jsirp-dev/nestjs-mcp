import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { NEST_MCP_OPTIONS, NEST_MCP_TOOL_CONTEXT } from '../constants.js';
import type { ResolvedNestMcpOptions } from '../nest-mcp.options.js';
import { registerAppTools } from './app.tools.js';
import { registerGraphTools } from './graph.tools.js';
import { registerLogsTools } from './logs.tools.js';
import { ToolRegistry } from './registry.js';
import { registerRoutesTools } from './routes.tools.js';
import type { ToolContext } from './tool-context.js';

/** Registers, once per instance, the tool groups whose switch is on. */
@Injectable()
export class NestMcpToolsSetup implements OnModuleInit {
  constructor(
    @Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(NEST_MCP_TOOL_CONTEXT) private readonly context: ToolContext,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) return;
    registerAppTools(this.registry, this.context);
    if (this.options.tools.graph) registerGraphTools(this.registry, this.context);
    if (this.options.tools.routes) registerRoutesTools(this.registry, this.context);
    if (this.options.tools.logs) registerLogsTools(this.registry, this.context);
  }
}
