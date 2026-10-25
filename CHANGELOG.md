# Changelog

Development logbook of `@jsirp/nestjs-mcp`: one entry per closed phase, with fixed fields (done,
deviations from the plan, hot decisions, stumbles and resolutions, critical information for later
phases, verification, final commit). The phased plan is in [`docs/plans/`](docs/plans/).

Entries are in reverse chronological order. Each phase closure adds its block following the
two-commit convention (commit 1 = work, commit 2 = this entry).

Release notes for npm (`## 0.1.0`, …) are added above the logbook starting with the first release.

---

<!-- PHASE ENTRIES START HERE -->

## Phase 3 — Routes with their guards, interceptors, pipes and filters (2026-10-25)

**Work commit:** `d398e8d` (ticket #5).

### Done

- `RoutesReader` and the route model (`src/routes/`): every `http-endpoint` entrypoint of the
  serialized graph whose controller's module is in scope, with `path`, `rawPath`, `version`,
  controller, handler, module, guards, interceptors, pipes, filters and matching middlewares.
- `routes_list` (filters `filter`, `method`, `controller`, `module`) and `route_get` (full or raw
  path), switched by `tools.routes`; `snapshot_disabled` without a graph, `not_found` with up to five
  `METHOD path` candidates.
- Enhancers in execution order: `global` (`ApplicationConfig`: `useGlobalX` instances and static
  `APP_X` providers, then request-scoped `APP_X`), `controller` and `method` (the controller node's
  `enhancers` in the graph), then parameter pipes with `param` (route-arguments metadata).
- Fixture: opt-in `APP_GUARD` (`appGuard`), `useGlobalGuards` and `setGlobalPrefix` options in the
  harness, and a `TraceMiddleware` on the cats routes (`middleware`). `test/routes.spec.ts`,
  `test/full-path.spec.ts`; "Routes and enhancers" section in the README.

### Deviations from the plan

- **The full path is Nest's, not recomputed.** The `http-endpoint` entrypoint's `metadata.path` is
  the output of Nest's own `RoutePathFactory`: prefix, `exclude` and URI version already applied,
  one entrypoint per version path. `src/routes/full-path.ts` does the reverse (`rawPath`) and
  resolves the version, so `exclude` is honoured by construction.
- **No `Reflector` and no `ModulesContainer`.** The controller class is the raw `metadata.token` of
  its graph node, and the parameter pipes are read with `Reflect.getMetadata` on it.
- **`RoutesReader` is not a Nest provider**: it lives on `ToolContext.routes`, like `GraphReader`,
  so `nest-mcp.module.ts` did not change.
- **The graph lists parameter pipes among the method's enhancers**, with nothing to tell them from
  `@UsePipes`. The reader removes, by name, one method-level pipe per parameter pipe and appends the
  parameter pipes after the rest, the order Nest runs them.

### Hot decisions

- `version` is `string | string[]`: a list only for header, media-type or custom versioning, where
  one registered path serves several versions. URI versioning resolves to the one in the path.
- `route_get` answers `ambiguous` with the full paths when a raw path matches several routes (one
  per version), and adds `middlewaresMatch: 'approximate'` next to the route.
- A parameter pipe on an argument without a name (`@Body(ValidationPipe)`) has `param: '#<index>'`.
- Middlewares match by method, by the version Nest recorded for them, and by raw path: exact for
  plain paths, by the prefix before a wildcard otherwise. `exclude(...)` on a middleware is not read.
- `SNAPSHOT_HINT` and `similar` are exported from `graph.tools.ts` and shared with the routes group.

### Stumbles and resolutions

- Middleware entrypoints carry the raw `forRoutes` path with a trailing slash (`/cats/`), no prefix
  and the route's version; route entrypoints carry the full path. Both are normalised before
  comparing.
- `ApplicationConfig.getGlobalGuards()` already holds static `APP_GUARD` instances (Nest adds them
  at scan time, before `useGlobalGuards` runs), so the two lists need no merge: that array is the
  order Nest runs them. The graph's `global: true` nodes are not needed for routes.
- An `exclude` entry is tested by Nest without the version segment and with a leading slash; the
  reverse check in `rawPath` does the same.
- `npx prettier` resolves a different Prettier than the project's: use `yarn prettier`.

### Critical information for later phases

- **Phase 5** can find a handler's route through `RoutesReader.read(scope)` (`controller`,
  `handler`) and its enhancer names and levels; instances are not in the model.
- **Phase 6b**: the entrypoint shape was read on Nest 11 only. The Nest 10 leg of the matrix is the
  first check that `metadata.path`, `controllerVersion` and middleware entrypoints look the same.
- **Phase 7**: RPC layers that serve procedures through middleware instead of controller handlers do
  not appear in `routes_list`; that is expected, not a bug.
- Not covered by a test: request-scoped global enhancers (`getGlobalRequestGuards`, named by their
  wrapper's `metatype`), a raw path served by several URI versions in one app, and global pipes,
  interceptors and filters (same code path as guards).

### Verification

- `yarn build && yarn test`: 8 suites, 84 tests green (61 at start, before any change).
- `test/routes.spec.ts`: 14 tests green, with prefix only, prefix plus URI versioning, `exclude`,
  globals, middlewares, `forFeature` scope, `snapshot: false` and the group switched off.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.

## Phase 2 — Module and provider graph, scope resolution (2026-10-25)

**Work commits:** `833a505` (ticket #3), `3c7bd7d` (ticket #4).

### Done

- `GraphReader` and the package's own model (`src/graph/`), mapped from `SerializedGraph.toJSON()`
  per call; iterative Tarjan in `src/graph/cycles.ts`.
- `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles`, switched by
  `tools.graph`. Without `snapshot` every one answers `snapshot_disabled` with `isError: true`; unknown
  names answer `not_found` with up to five `candidates`.
- Scope resolution (`src/instance/scope.ts`): `resolveScope`, `inScope`, `describeScope`. A
  `forFeature` instance observes the module that imports it and that module's transitive imports;
  `app_info.scope` and every graph answer (errors included) say which. `forRoot` keeps app scope.
- `test/graph.spec.ts`, `test/scope.spec.ts`, `test/cycles.spec.ts`; "Graph" section and scope notes
  in the README.

### Deviations from the plan

- **`GraphReader` is not a Nest provider**: it lives on `ToolContext.graph`, built in the tool-context
  factory from the injected `SerializedGraph`.
- **Modules sharing a class name** are named `Name#1`, `Name#2` in graph insertion order, not by id
  suffix, so ids never reach the agent.
- **The instance's module is found by a marker, not by its options object**: the serialized graph
  holds no provider values, so each enabled instance provides a fresh `Symbol(NEST_MCP_INSTANCE)` and
  the reader finds its node by token identity (`GraphReader.moduleDeclaring`). The marker shows in
  app-scope provider listings as `NEST_MCP_INSTANCE`.
- **`resolveScope(graph, instanceModuleId)`** takes the module's graph id (not a token) and returns a
  third kind, `unresolved`, besides `app` and `module`.

### Hot decisions

- `graph_provider` takes an optional `module` and answers `ambiguous` with `{ token, module }`
  candidates when a token is declared in several modules; `includeInternal` is accepted by
  `graph_module` and `graph_provider` too.
- `dependsOn`/`dependents` count constructor and property injection only; `decorator` edges are kept
  in the model (`GraphEdge.injection`, `GraphClass.enhancers`) for phase 3.
- `ToolError` takes a third `details` argument, spread into the error answer.
- **The scope answer** is `{ kind: 'app' }`, `{ kind: 'module', module: 'CatsModule' }` or, unresolved,
  `{ kind: 'module', module: null, error: 'scope_unresolved', fallback: 'app' }`.
- **The closure excludes** Nest's internal modules (even with `includeInternal`) and the instance's
  own module: an inspector does not list itself. Internal providers of in-scope modules still show
  with `includeInternal`.
- **Several importers** of one `forFeature` definition join their closures; `module` names the first
  in graph order.
- **Injection edges show only when both ends are in scope**, so `dependents` never names a class the
  instance cannot see.
- A resolved scope is kept for the instance's lifetime; while there is no graph the instance answers
  `unresolved` and retries on the next call.

### Stumbles and resolutions

- `toJSON()` returns raw tokens and labels (class functions, symbols): everything goes through
  `tokenText`, and the raw token is what lets the marker be matched by identity.
- Module nodes carry no imports/exports/providers lists: derived from `parent` and edges. Each module
  also has internal provider nodes (the module class, `ModuleRef`, `ApplicationConfig`).
- Nest 11 records no `scope` on provider metadata: derived from `static`/`transient`.
- A module's own `ModuleRef` keeps its module id private, so it cannot name the instance's module.

### Critical information for later phases

- **`inScope(context.scope(), moduleName)` is the filter every later group applies**, by graph module
  name (`Name#n` on collision). `context.scope()` is cheap after the first resolution.
- `GraphModel.classes[*].enhancers` (with `methodKey`) and `decorator` edges are what phase 3 uses for
  per-route enhancers.
- `exports` lists exported providers only; re-exported modules are not in the serialized graph.
- Not covered by a test: the `global: true` mark on `APP_*` enhancers and tool-level cycles (the
  fixture has neither; Tarjan has unit tests), and `forFeatureAsync` scope (same `defineInstance`
  path as `forFeature`).

### Verification

- `yarn build && yarn test`: 6 suites, 61 tests green.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.
- The `forFeature` instance in `CatsModule`: `app_info.scope` is
  `{ kind: 'module', module: 'CatsModule' }` and `graph_modules` is `['CatsModule', 'OwnersModule']`;
  the `forRoot` instance lists all five modules; with `snapshot: false` it answers `scope_unresolved`
  and `snapshot_disabled` without crashing.
- Not run: "`yarn test` green at start" was not checked before the changes; left unticked.

## Phase 1 — Package bootstrap and MCP endpoint (2026-10-25)

**Work commits:** `20c7fed` (ticket #1), `a1f64c3` (ticket #2).

### Done

- Publishable package with self-contained tooling: its own `yarn.lock`, tsup ESM + CJS + `.d.ts`,
  ts-jest, ESLint with `import/no-extraneous-dependencies`, Prettier, a check-only husky pre-commit.
- `NestMcpModule.forRoot`/`forRootAsync`/`forFeature`/`forFeatureAsync` through
  `ConfigurableModuleBuilder`; `forFeature` without `path` throws at definition time naming the option.
- One controller subclass per instance, version-neutral, carrying its own path and guards metadata.
  Several instances coexist in one app, and two apps in one process keep their own path and guards.
- Stateless Streamable HTTP endpoint: `POST` serves MCP, `GET` and `DELETE` answer 405 with
  `Allow: POST`.
- `LocalOnlyGuard` followed by `options.guards`.
- Bootstrap log, once per instance, context `NestMcp`: the full endpoint URL (`log`). Two warnings
  (`warn`), each once per instance and only when its condition holds: the app was created without
  `snapshot: true`, and the endpoint is open to the network without guards.
- `app_info`: server info, Nest and Node versions, uptime, global prefix, versioning, endpoint path,
  scope kind, whether `snapshot` is on, live groups, and `options` (resolved tool switches and
  `requests.headers`).
- Fixture app (`CatsModule`, `OwnersModule`), SDK-client harness (`test/support/start-app.ts`) with a
  recording logger, and `test/transport.spec.ts`, `test/instances.spec.ts` and
  `test/local-only.guard.spec.ts`. README and this logbook.

### Deviations from the plan

- **`enabled` from an async factory cannot unregister the route**: the route exists before the
  factory runs. `EnabledGuard` answers 404 instead. A static `enabled` (sync, or next to `useFactory`)
  registers nothing.
- **User guards are not listed as providers.** Nest instantiates them from the guards metadata of the
  controller subclass, inside the inspector's module. Their dependencies must therefore come from
  global modules or from `imports` (async). The README says so.
- **`app_info` gained `options`** (`tools` switches and `requests.headers`). Ticket #2 wants the
  resolved switches visible. `app_info.tools` keeps its meaning (which groups are live), and in this
  phase every group reports `false`.

### Hot decisions

- `app_info.options` is a separate field, not a reinterpretation of `tools`. Later phases need both
  views: a group switched on whose optional peer is missing is `options.tools.x: true` with
  `tools.x: false`.
- Markdown is excluded from Prettier: the docs are hand-wrapped.

### Stumbles and resolutions

- An empty `yarn.lock` makes this folder its own Yarn project, so a host workspace is untouched.
- ESLint 8 silently skips `.ts` files without `--ext .ts,.cjs`. The flag is in the `lint` script.
- Deep imports into `@nestjs/common`/`@nestjs/core` need `.js` under `NodeNext`. The stable metadata
  keys are declared locally instead.
- The SDK's `registerTool` generic overflows with mixed zod shapes, so it is called through a narrow
  signature.
- **Yarn 4 does not run `pre*` scripts**, so `pretest` never builds. Run `yarn build` before
  `yarn test`, or tests run against a stale `dist/`. Left as is: the CI phase (6b) should make `test`
  build explicitly.

### Critical information for later phases

- Tests consume `dist/index.cjs` through `moduleNameMapper`, so they exercise the published build.
  That build emits no `design:paramtypes`, which proves the explicit `@Inject`s. For type-checking,
  `tsconfig` `paths` points the package name at `src`.
- The Nest version is read from `@nestjs/core/package.json` via `createRequire(__filename)`. tsup
  `shims: true` turns that into `import.meta.url` in the ESM build, which was smoke-tested.
- `ToolRegistry` plus `registerXTools(registry, context)` is the extension point. `NestMcpToolsSetup`
  is where each group is switched on through `options.tools.<group>`.
- `NEST_MCP_TOOL_CONTEXT` already carries `SerializedGraph` when it can be injected. Phase 2 resolves
  `scope.module`, which is `null` today.
- **Host risk (phase 7):** this checkout's own `node_modules` holds its own `@nestjs/core`. A host
  resolving the package source from here could load two Nest copies, and then class tokens such as
  `ApplicationConfig` would not match.
- Not run: the host's own install/build prerequisite, which is left unticked in the phase document.

### Verification

- `yarn build && yarn test`: 3 suites, 32 tests green.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.
- `git grep -n -i 'pino\|orpc\|mongo' src test`: no matches.
