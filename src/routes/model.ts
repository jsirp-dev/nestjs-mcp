/** Where an enhancer is bound. Nest runs guards, interceptors and pipes in this order. */
export type EnhancerLevel = 'global' | 'controller' | 'method';

export interface Enhancer {
  /** The class name (an instance by its constructor's name). */
  name: string;
  level: EnhancerLevel;
  /** Parameter pipes: the argument they transform, `'id'` for `@Param('id', ParseIntPipe)`. */
  param?: string;
}

/** One HTTP route as Nest registered it, with the enhancer chain it runs. */
export interface RouteModel {
  method: string;
  /** As the app serves it: global prefix (unless excluded) and URI version included. */
  path: string;
  /** The controller and method paths alone, without prefix or version. */
  rawPath: string;
  /** `'neutral'` for `VERSION_NEUTRAL`; a list when the handler serves several by header or media type. */
  version?: string | string[];
  controller: string;
  handler: string;
  module: string;
  /** Each list in execution order: `global` → `controller` → `method`, declaration order within. */
  guards: Enhancer[];
  interceptors: Enhancer[];
  pipes: Enhancer[];
  /** Listed in the same order; Nest tries them the other way round (method first, global last). */
  filters: Enhancer[];
  /** Middleware classes whose `forRoutes` path matches; approximate for wildcards. */
  middlewares: string[];
}
