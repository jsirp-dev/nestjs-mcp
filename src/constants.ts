/** Logger context of every message the inspector writes. */
export const LOGGER_CONTEXT = 'NestMcp';

/** Injection token of the instance's resolved options (`ResolvedNestMcpOptions`). */
export const NEST_MCP_OPTIONS = Symbol('NEST_MCP_OPTIONS');

/** Injection token of the instance's tool context (`ToolContext`). */
export const NEST_MCP_TOOL_CONTEXT = Symbol('NEST_MCP_TOOL_CONTEXT');

/**
 * Description of the per-instance marker token: each enabled instance provides a fresh
 * `Symbol(NEST_MCP_INSTANCE)` so its own module node can be found in the serialized graph.
 */
export const NEST_MCP_INSTANCE = 'NEST_MCP_INSTANCE';

/**
 * Nest's metadata keys, declared here because deep imports into `@nestjs/common/constants` do not
 * resolve under `NodeNext`. Their values have been stable since Nest 7.
 */
export const PATH_METADATA = 'path';
export const GUARDS_METADATA = '__guards__';
export const ROUTE_ARGS_METADATA = '__routeArguments__';

export const DEFAULT_PATH = '_mcp';
export const DEFAULT_LOGS_BUFFER_SIZE = 2000;
export const DEFAULT_REQUESTS_BUFFER_SIZE = 500;
export const DEFAULT_ID_HEADER = 'x-nest-mcp-request-id';
