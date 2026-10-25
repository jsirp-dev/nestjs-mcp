import { Injectable } from '@nestjs/common';
import type { ToolGroup } from '../nest-mcp.options.js';

/** A zod raw shape (`{ field: z.string() }`), kept opaque so any zod major the SDK accepts fits. */
export type ToolInputShape = Record<string, unknown>;

export interface ToolDefinition {
  /** `snake_case`, prefixed with its group. */
  name: string;
  description: string;
  inputSchema?: ToolInputShape;
  handler(input: Record<string, unknown>): unknown;
}

/** A failure a tool reports to the agent as `{ error, hint }` with `isError: true`. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    readonly hint: string,
  ) {
    super(`${code}: ${hint}`);
  }
}

/**
 * The tools of one instance. Internal: each tool group plugs in through its own
 * `registerXTools(registry, context)`; the host app cannot add tools (ADR-0003).
 */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition & { group: ToolGroup }>();

  register(group: ToolGroup, tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`NestMcpModule: tool ${tool.name} is registered twice.`);
    }
    this.tools.set(tool.name, { ...tool, group });
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Whether at least one tool of the group is registered, which is what "live" means. */
  isLive(group: ToolGroup): boolean {
    for (const tool of this.tools.values()) if (tool.group === group) return true;
    return false;
  }
}
