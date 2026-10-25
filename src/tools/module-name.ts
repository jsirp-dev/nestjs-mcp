import type { GraphReader } from '../graph/graph-reader.js';
import { isGraphUnavailable } from '../graph/model.js';
import type { ContainerModuleLike } from '../support/for-each-instance.js';

/**
 * Names a container module the way the scope does: by its node in the serialized graph, else by
 * its class name. The graph is read once per call of the returned function's caller.
 */
export function moduleNamer(graph: GraphReader): (module: ContainerModuleLike) => string {
  const model = graph.read();
  return (module) =>
    (!isGraphUnavailable(model) && module.id !== undefined
      ? model.modules[module.id]?.name
      : undefined) ??
    module.name ??
    'unknown';
}
