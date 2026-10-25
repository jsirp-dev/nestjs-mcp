import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, type ToolDefinition, type ToolRegistry } from '../tools/registry.js';

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * `McpServer.registerTool` seen through a narrow signature. Its generic over mixed zod shapes
 * overflows the type checker ("excessively deep") in some configurations, so the package crosses
 * the SDK boundary here, once.
 */
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema?: Record<string, unknown> },
  callback: (...args: unknown[]) => Promise<TextResult>,
) => unknown;

function text(value: unknown, isError = false): TextResult {
  const result: TextResult = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (isError) result.isError = true;
  return result;
}

async function run(tool: ToolDefinition, input: Record<string, unknown>): Promise<TextResult> {
  try {
    return text(await tool.handler(input));
  } catch (error) {
    if (error instanceof ToolError) return text({ error: error.code, hint: error.hint }, true);
    const message = error instanceof Error ? error.message : String(error);
    return text({ error: 'internal_error', hint: message }, true);
  }
}

/** A fresh MCP server with every tool of the registry; stateless, one per request. */
export function createMcpServer(
  registry: ToolRegistry,
  serverInfo: { name: string; version: string },
): McpServer {
  const server = new McpServer(serverInfo, { capabilities: { tools: {} } });
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  for (const tool of registry.list()) {
    const config = tool.inputSchema
      ? { description: tool.description, inputSchema: tool.inputSchema }
      : { description: tool.description };
    // With an input schema the SDK calls back with (args, extra); without one, with (extra).
    registerTool(tool.name, config, (...args) =>
      run(tool, tool.inputSchema ? ((args[0] as Record<string, unknown>) ?? {}) : {}),
    );
  }
  return server;
}
