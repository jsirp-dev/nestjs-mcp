import type { VersioningOptions } from '@nestjs/common';
import { GraphReader, type SerializedGraphLike } from '../graph/graph-reader.js';
import type { ExcludedRoute } from '../routes/full-path.js';
import { RoutesReader } from '../routes/routes-reader.js';
import { isGraphUnavailable } from '../graph/model.js';
import type { EventsInspector } from '../events/install-events.js';
import type { LogTee } from '../logs/log-tee.js';
import type { TraceRecorder } from '../requests/trace-recorder.js';
import { resolveScope, type InstanceScope } from '../instance/scope.js';
import { trimSlashes, type ResolvedNestMcpOptions } from '../nest-mcp.options.js';

/** What the inspector reads from Nest's `ApplicationConfig`. Duck-typed on purpose. */
export interface ApplicationConfigLike {
  getGlobalPrefix(): string;
  getVersioning(): VersioningOptions | undefined;
  /** `exclude` lists the routes left out of the global prefix. */
  getGlobalPrefixOptions?(): { exclude?: ExcludedRoute[] };
}

/** Everything a tool group needs to answer within its instance. */
export interface ToolContext {
  options: ResolvedNestMcpOptions;
  applicationConfig: ApplicationConfigLike;
  /** Absent when the running Nest does not provide it. */
  serializedGraph: SerializedGraphLike | undefined;
  /** Reads the serialized graph into the package's model, per call. */
  graph: GraphReader;
  /** Reads the routes Nest registered and the enhancers each runs, per call. */
  routes: RoutesReader;
  /**
   * The process-wide Logger tee this instance reads, set at `onModuleInit` of the instance when the
   * `logs` group is on; `undefined` before that or with the group off.
   */
  logTee: LogTee | undefined;
  /**
   * The app's request traces this instance reads, set in `configure` of the instance's module when
   * the `requests` group is on; `undefined` before that or with the group off.
   */
  traces: TraceRecorder | undefined;
  /**
   * The app's emitter and its recorded emissions, set in `configure` of the instance's module when
   * the `events` group is on, `@nestjs/event-emitter` is installed and the app imports its module;
   * `undefined` otherwise, and then the group is not registered.
   */
  events: EventsInspector | undefined;
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
    routes: new RoutesReader(serializedGraph, graph, applicationConfig),
    logTee: undefined,
    traces: undefined,
    events: undefined,
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
