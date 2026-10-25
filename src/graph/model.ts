/**
 * The package's own model of what Nest built, mapped from `SerializedGraph.toJSON()` so nothing
 * else depends on Nest's internal shape. Keys and references are graph ids, which are internal:
 * tools answer by name and never hand an id to the agent.
 */

export type ProviderScope = 'DEFAULT' | 'REQUEST' | 'TRANSIENT';

export type ClassKind = 'provider' | 'controller' | 'injectable' | 'middleware';

export interface GraphModule {
  id: string;
  /** The module's class name; suffixed `#n` in graph order when several modules share it. */
  name: string;
  global: boolean;
  dynamic: boolean;
  internal: boolean;
  /** Ids of the modules this one declares in its `imports`. */
  imports: string[];
  /**
   * Ids of the global modules Nest linked to this one without its declaring them: every module
   * gets every global module (and `InternalCoreModule`) this way.
   */
  globals: string[];
  /** Ids of the classes this module exports. */
  exports: string[];
  /** Ids of the classes of kind `provider` declared in this module. */
  providers: string[];
  /** Ids of the controllers declared in this module. */
  controllers: string[];
}

export interface GraphEnhancer {
  name: string;
  subtype: string;
  methodKey?: string;
}

export interface GraphClass {
  id: string;
  /** The token as text: a class by its name, a symbol or string by its description. */
  name: string;
  kind: ClassKind;
  /** Id of the module that declares it. */
  module: string;
  scope: ProviderScope;
  durable: boolean;
  exported: boolean;
  internal: boolean;
  token: string;
  initTimeMs: number;
  /** `guard`, `interceptor`, `pipe` or `filter` for enhancers. */
  subtype?: string;
  /** A globally registered enhancer (`APP_GUARD` and friends). */
  global?: boolean;
  /** The enhancers attached to a controller (class level, or per method with `methodKey`). */
  enhancers?: GraphEnhancer[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'module-to-module' | 'class-to-class';
  internal: boolean;
  /** Module edges: Nest's link to a global module the source does not declare. */
  implicit?: true;
  /** Class edges: how the dependency arrives. `decorator` attaches an enhancer. */
  injection?: 'constructor' | 'property' | 'decorator';
  /** Class edges: the constructor index or property key, as text. */
  key?: string;
}

export interface GraphModel {
  modules: Record<string, GraphModule>;
  classes: Record<string, GraphClass>;
  edges: GraphEdge[];
}

/** Why there is no graph: the app was created without `snapshot: true`. */
export interface GraphUnavailable {
  unavailable: 'snapshot_disabled';
}

export function isGraphUnavailable(
  value: GraphModel | GraphUnavailable,
): value is GraphUnavailable {
  return 'unavailable' in value;
}
