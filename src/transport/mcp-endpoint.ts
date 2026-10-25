import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './create-mcp-server.js';
import { jsonRpcError } from './listener.js';

/**
 * Answers one MCP `POST` of an instance: a fresh server and transport per request (stateless),
 * closed with the response. The transport reads the body itself; nothing has parsed it before.
 */
export function createMcpHandler(
  registry: ToolRegistry,
  serverInfo: { name: string; version: string },
  onError: (message: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const server = createMcpServer(registry, serverInfo);
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
      await transport.handleRequest(req, res);
    } catch (error) {
      onError(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error', -32603);
    }
  };
}
