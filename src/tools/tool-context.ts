import type { VersioningOptions } from '@nestjs/common';
import { GraphReader, type SerializedGraphLike } from '../graph/graph-reader.js';
import { isGraphUnavailable } from '../graph/model.js';
import { resolveScope, type InstanceScope } from '../instance/scope.js';
import { trimSlashes, type ResolvedNestMcpOptions } from '../nest-mcp.options.js';

/** What the inspector reads from Nest's `ApplicationConfig`. Duck-typed on purpose. */
export interface ApplicationConfigLike {
  getGlobalPrefix(): string;
  getVersioning(): VersioningOptions | undefined;
}

/** Everything a tool group needs to answer within its instance. */
export interface ToolContext {
  options: ResolvedNestMcpOptions;
  applicationConfig: ApplicationConfigLike;
  /** Absent when the running Nest does not provide it. */
  serializedGraph: SerializedGraphLike | undefined;
  /** Reads the serialized graph into the package's model, per call. */
  graph: GraphReader;
  /** The endpoint as the app serves it: global prefix plus path, with a leading slash. */
  mcpPath(): string;
  /** Whether the app was created with `snapshot: true` (the serialized graph has nodes). */
  snapshotEnabled(): boolean;
  /**
   * What this instance observes. Resolved from the graph at the first call that can (the graph
   * exists only after `app.init()`) and kept; `unresolved` while there is no graph.
   */
  scope(): InstanceScope;
}

export function createToolContext(
  options: ResolvedNestMcpOptions,
  applicationConfig: ApplicationConfigLike,
  serializedGraph: SerializedGraphLike | undefined,
  /** The instance's own marker token, provided in its module (`NEST_MCP_INSTANCE`). */
  instanceToken: symbol,
): ToolContext {
  const graph = new GraphReader(serializedGraph);
  let resolved: InstanceScope | undefined = options.scope === 'app' ? { kind: 'app' } : undefined;
  return {
    options,
    applicationConfig,
    serializedGraph,
    graph,
    mcpPath() {
      const prefix = trimSlashes(applicationConfig.getGlobalPrefix());
      return `/${[prefix, options.path].filter(Boolean).join('/')}`;
    },
    snapshotEnabled() {
      const nodes = serializedGraph?.toJSON().nodes;
      return nodes !== undefined && Object.keys(nodes).length > 0;
    },
    scope() {
      if (resolved) return resolved;
      const model = graph.read();
      if (isGraphUnavailable(model)) return { kind: 'unresolved' };
      resolved = resolveScope(model, graph.moduleDeclaring(instanceToken));
      return resolved;
    },
  };
}
