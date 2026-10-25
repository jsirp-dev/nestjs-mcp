import { ROUTE_ARGS_METADATA } from '../constants.js';

/** One entry of a handler's route-arguments metadata (`@Param`, `@Body`, a custom decorator…). */
export interface RouteArgument {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

/** An argument with the `type` its pipes receive in their `ArgumentMetadata`. */
interface TypedArgument {
  type: string;
  argument: RouteArgument;
}

/**
 * The `ArgumentMetadata.type` Nest gives the pipes of an argument, by the paramtype in its metadata
 * key: `body` (3), `query` (4), `param` (5); `custom` for files (8, 9), the raw body (12) and
 * custom decorators, whose key does not start with a number. The rest never run pipes.
 */
const PIPED: Record<string, string> = {
  '3': 'body',
  '4': 'query',
  '5': 'param',
  '8': 'custom',
  '9': 'custom',
  '12': 'custom',
};

/** Per controller class and handler key, the arguments that run pipes. */
const cache = new WeakMap<object, Map<string, TypedArgument[]>>();

/** A handler's route arguments, by index. */
export function routeArguments(controller: unknown, handler: string): RouteArgument[] {
  if (typeof controller !== 'function') return [];
  const metadata = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ?? {}) as Record<
    string,
    RouteArgument
  >;
  return Object.values(metadata).sort((a, b) => a.index - b.index);
}

/** How routes and traces name an argument: its name (`'id'`), or `#<index>` without one. */
export function argumentName(argument: RouteArgument): string {
  return typeof argument.data === 'string' ? argument.data : `#${argument.index}`;
}

function pipedArguments(controller: object, handler: string): TypedArgument[] {
  let byHandler = cache.get(controller);
  if (!byHandler) cache.set(controller, (byHandler = new Map()));
  let found = byHandler.get(handler);
  if (!found) {
    const metadata = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ??
      {}) as Record<string, RouteArgument>;
    found = Object.entries(metadata).flatMap(([key, argument]) => {
      const paramtype = key.split(':')[0]!;
      const type = /^\d+$/.test(paramtype) ? PIPED[paramtype] : 'custom';
      return type === undefined ? [] : [{ type, argument }];
    });
    byHandler.set(handler, found);
  }
  return found;
}

/**
 * The argument a pipe call runs on, from the `type` and `data` it received: Nest does not pass the
 * index. Several candidates (two `@Body()`) are told apart by whose own pipes include `pipe`, its
 * instance or its class; still ambiguous, none.
 */
export function argumentOf(
  controller: unknown,
  handler: string,
  metadata: { type?: unknown; data?: unknown },
  pipe: unknown,
): RouteArgument | undefined {
  if (typeof controller !== 'function') return undefined;
  const candidates = pipedArguments(controller, handler)
    .filter(({ type, argument }) => type === metadata.type && argument.data === metadata.data)
    .map(({ argument }) => argument);
  if (candidates.length <= 1) return candidates[0];
  const pipeClass = (pipe as { constructor?: unknown } | null)?.constructor;
  const own = candidates.filter((argument) =>
    (argument.pipes ?? []).some((item) => item === pipe || item === pipeClass),
  );
  return own.length === 1 ? own[0] : undefined;
}
