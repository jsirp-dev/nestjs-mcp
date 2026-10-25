# Phase 3 — Routes with their guards, interceptors, pipes and filters

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-02-graph.md`](./phase-02-graph.md)
> Next phase: [`phase-04-logs.md`](./phase-04-logs.md)

## Objective

The agent sees every HTTP route in scope with its method, full path (global prefix and version
included), controller and handler, and the real chain of enhancers Nest will apply, in order: global,
controller and method, separating guards, interceptors, pipes and filters, plus the middlewares that
match. Routes registered by RPC layers built on controllers are not special: they are routes like any other.

At the end: `route_get({ method: 'GET', path: '/api/cats/:id' })` on the fixture app answers
`guards: [{ name: 'ApiKeyGuard', level: 'controller' }]`, `interceptors: [TimingInterceptor]`,
`pipes: [{ name: 'ParseIntPipe', level: 'method', param: 'id' }]`, `filters: [NotFoundFilter]`.

## Prerequisites

- [x] Phase 2 closed.
- [x] `GraphModel` keeps `enhancers` per class (phase 2 note).

## Closed decisions for this phase

- **Two sources, combined**: the `SerializedGraph` entrypoints give the routes (`type:
  'http-endpoint'`, `metadata.path`, `requestMethod`, `methodVersion`, `controllerVersion`) and the
  middlewares (`type: 'middleware'`); class and method enhancers come from
  `ClassNode.metadata.enhancers` and, for parameter pipes, from `ROUTE_ARGS_METADATA` on the handler
  through `Reflector`. Globals registered with `app.useGlobalGuards(...)` (instances, not `APP_GUARD`)
  come from `ApplicationConfig`.
- **Full path computed the way Nest does**: global prefix (minus `exclude`), URI version when it
  applies (`defaultVersion` when the handler declares none), controller path, method path. The raw path
  is exposed too, for apps that version by header.
- **Execution order** reflected in the answer: `global` → `controller` → `method`, declaration order
  within a level. That is the order Nest applies guards and interceptors; filters resolve in reverse,
  and the doc says so.
- **Scope filter**: only routes whose controller's module is in scope.
- **No instances**: class names and levels only.

## Steps

### 1. Routes reader

`src/routes/routes-reader.ts`: `RoutesReader` over `GraphReader`, `ApplicationConfig`, `Reflector` and
`ModulesContainer`. `read(scope): RouteModel[]`:

```ts
type Enhancer = { name: string; level: 'global' | 'controller' | 'method'; param?: string };
type RouteModel = {
  method: string; path: string; rawPath: string; version?: string; controller: string; handler: string;
  module: string; guards: Enhancer[]; interceptors: Enhancer[]; pipes: Enhancer[]; filters: Enhancer[];
  middlewares: string[];
};
```

Parameter pipes: `Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler)` gives, per argument,
`{ index, data, pipes }`; `data` is the parameter name (`'id'` in `@Param('id', ParseIntPipe)`).

### 2. Tools

`src/tools/routes.tools.ts`:

| Tool | Input | Output |
|------|-------|--------|
| `routes_list` | `{ filter?: string; method?: string; controller?: string; module?: string }` | Matching routes, one line each: method, path, `Controller.handler`, enhancer counts |
| `route_get` | `{ method: string; path: string }` | The full `RouteModel`; on no exact match, up to five candidates |

`route_get` accepts the full path (`/api/cats/:id`) or the raw one (`/cats/:id`).

### 3. Tests and docs

`test/routes.spec.ts`: the fixture app with `setGlobalPrefix('api')` plus URI versioning in one boot and
without versioning in another; full paths, the controller-level `ApiKeyGuard`, `ParseIntPipe` with
`param: 'id'`, a guard added with `app.useGlobalGuards(new GlobalGuard())` listed with `level:
'global'` before the controller one, the MCP endpoint itself listed (with `LocalOnlyGuard`), and the
`forFeature` instance listing only `CatsModule` routes. "Routes and enhancers" section in the README
with the level table and the note on filter order.

## Files

### Created

- `src/routes/{model.ts,routes-reader.ts,full-path.ts}`
- `src/tools/routes.tools.ts`
- `test/routes.spec.ts`

### Modified

- `src/nest-mcp.module.ts`, `src/tools/app.tools.ts` (`tools.routes`)
- `README.md`

## Verification / definition of done

- [x] `routes.spec.ts` green in both modes (with and without versioning).
- [x] An instance global guard and an `APP_GUARD` one both appear with `level: 'global'`.
- [x] `routes_list({ filter: 'cats' })` does not return `/api/_mcp`; without filter it does.
- [x] The `forFeature` instance does not list routes outside its scope.
- [x] `yarn build`, `lint`, `type-check` green.

## Likely stumbles

- **`APP_GUARD` vs `useGlobalGuards`**: the first are graph nodes with `metadata.global: true` and a
  `subtype`; the second live only in `ApplicationConfig.getGlobalGuards()` as instances (name through
  `constructor.name`). Merge both lists.
- **Global prefix `exclude`**: `ApplicationConfig.getGlobalPrefixOptions().exclude` is a list of
  `{ path, method }`; honour it or `route_get` lies for excluded routes.
- **`VERSION_NEUTRAL`** is a symbol: serialise as `'neutral'`.
- **RPC layers on top of Nest** (contract-first routers that implement procedures as controller
  handlers) register ordinary routes; if some do not show up in phase 7 it is because they use
  middleware instead. Do not handle here; note it.
- **Middlewares**: `middleware` entrypoints carry the `forRoutes` path; wildcard matching is
  approximate. Return those matching by prefix and mark the field "approximate".

## Phase closure — two mandatory commits

Commit 1: `feat(nestjs-mcp): list routes with their guards, interceptors, pipes and filters (Phase 3)`.
Commit 2: `chore(nestjs-mcp): close phase 3`. Then, if a host embeds this repo as a submodule, its
pointer on the host side. The person launches them.

## Notes for the next session (Phase 4)

- Phase 4 does not touch the graph. It replaces `logger: false` in the fixture with a test logger that
  writes through Nest's `Logger`; the harness should accept `logger`.
