import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  VERSION_NEUTRAL,
  type CanActivate,
  type Type,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GUARDS_METADATA, LOGGER_CONTEXT, NEST_MCP_OPTIONS, PATH_METADATA } from '../constants.js';
import type { ResolvedNestMcpOptions } from '../nest-mcp.options.js';
import { ToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './create-mcp-server.js';

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function methodNotAllowed(res: ServerResponse): void {
  res.setHeader('Allow', 'POST');
  jsonRpcError(res, 405, -32000, 'Method not allowed: this MCP endpoint is stateless, use POST.');
}

/**
 * The endpoint of one instance. Never mounted as is: `createInstanceController` subclasses it per
 * instance and writes the path and guards on the subclass, so instances never share metadata.
 */
@Controller({ version: VERSION_NEUTRAL })
export class NestMcpController {
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(
    @Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
  ) {}

  @Post()
  async handle(
    @Req() req: IncomingMessage & { body?: unknown },
    @Res() res: ServerResponse,
  ): Promise<void> {
    const server = createMcpServer(this.registry, this.options.serverInfo);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // Nest has already parsed the body; without it the SDK would read a consumed stream.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(`MCP request failed: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  }

  @Get()
  get(@Res() res: ServerResponse): void {
    methodNotAllowed(res);
  }

  @Delete()
  delete(@Res() res: ServerResponse): void {
    methodNotAllowed(res);
  }
}

/** A controller class of its own for one instance, with its route and guards. */
export function createInstanceController(
  path: string,
  guards: Type<CanActivate>[],
): Type<NestMcpController> {
  class InstanceController extends NestMcpController {}
  Object.defineProperty(InstanceController, 'name', { value: `NestMcpController[${path}]` });
  Reflect.defineMetadata(PATH_METADATA, path, InstanceController);
  Reflect.defineMetadata(GUARDS_METADATA, guards, InstanceController);
  return InstanceController;
}
