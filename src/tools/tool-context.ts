import type { VersioningOptions } from '@nestjs/common';
import { trimSlashes, type ResolvedNestMcpOptions } from '../nest-mcp.options.js';

/** What the inspector reads from Nest's `ApplicationConfig`. Duck-typed on purpose. */
export interface ApplicationConfigLike {
  getGlobalPrefix(): string;
  getVersioning(): VersioningOptions | undefined;
}

/** What the inspector reads from Nest's `SerializedGraph`. Duck-typed on purpose. */
export interface SerializedGraphLike {
  toJSON(): { nodes?: Record<string, unknown> };
}

/** Everything a tool group needs to answer within its instance. */
export interface ToolContext {
  options: ResolvedNestMcpOptions;
  applicationConfig: ApplicationConfigLike;
  /** Absent when the running Nest does not provide it. */
  serializedGraph: SerializedGraphLike | undefined;
  /** The endpoint as the app serves it: global prefix plus path, with a leading slash. */
  mcpPath(): string;
  /** Whether the app was created with `snapshot: true` (the serialized graph has nodes). */
  snapshotEnabled(): boolean;
}

export function createToolContext(
  options: ResolvedNestMcpOptions,
  applicationConfig: ApplicationConfigLike,
  serializedGraph: SerializedGraphLike | undefined,
): ToolContext {
  return {
    options,
    applicationConfig,
    serializedGraph,
    mcpPath() {
      const prefix = trimSlashes(applicationConfig.getGlobalPrefix());
      return `/${[prefix, options.path].filter(Boolean).join('/')}`;
    },
    snapshotEnabled() {
      const nodes = serializedGraph?.toJSON().nodes;
      return nodes !== undefined && Object.keys(nodes).length > 0;
    },
  };
}
