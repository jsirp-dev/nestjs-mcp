# Changelog

Development logbook of `@jsirp/nestjs-mcp`: one entry per closed phase, with fixed fields (done,
deviations from the plan, hot decisions, stumbles and resolutions, critical information for later
phases, verification, final commit). The phased plan is in [`docs/plans/`](docs/plans/).

Entries are in reverse chronological order. Each phase closure adds its block following the
two-commit convention (commit 1 = work, commit 2 = this entry).

Release notes for npm (`## 0.1.0`, …) are added above the logbook starting with the first release.

---

<!-- PHASE ENTRIES START HERE -->

## Phase 5 — Request traces through guards, interceptors, pipes, filters and handler (2026-10-25)

**Work commit:** `c267821` (ticket #7).

### Done

- Trace model (`src/requests/model.ts`), `AsyncLocalStorage` context and step recording
  (`trace-context.ts`, 256 steps per trace, the rest counted in `droppedSteps`), `TraceRecorder`
  (`trace-recorder.ts`): id from `requests.idHeader` or a UUID, method, URL with query, headers per
  `requests.headers`, status and duration on `finish`/`close` (`aborted` when it closed first).
- `wrapEnhancers` (`wrap-enhancers.ts`): wraps `canActivate`, `intercept`, `transform` and `catch`
  in place, transparently (same `this`, same value, same exception; Promises chained, Observables
  lifted through their own class), marked with `Symbol.for('nestjs-mcp.wrapped')`. Interceptors
  record `enter` and `exit`, and `shortCircuited` when `next.handle()` was never called.
- `NestMcpHandlerInterceptor`: names controller, handler and route and inserts the handler step
  where it ran, after the pipes and before the interceptors' exits; no handler step when a pipe or
  an interceptor stopped the request.
- `requests_list` (`limit`, `method`, `path`, `status`, `minStatus`, `scope`) and `request_trace`
  (`id`, `scope`), switched by `tools.requests`; `level` and `module` from the route (phase 3's
  `RoutesReader`), `notTraced` for `REQUEST`/`TRANSIENT` enhancers on the route.
- Fixture: opt-in `OwnerGuard` (`APP_GUARD` injecting `OwnersService`, returns `false`),
  `RequestScopedInterceptor` and `HealthModule`. `test/requests.spec.ts` (21),
  `test/wrap-enhancers.spec.ts` (7); "Request traces" section and limitations in the README.

### Deviations from the plan

- **Installed in `NestMcpModule.configure`, not `onApplicationBootstrap`** (closed decision 10).
  Nest binds every exception filter's `catch` (`instance.catch.bind(instance)`) when it builds the
  routes, which is before every lifecycle hook; `configure` runs in `init()` just before that, with
  every instance created and `useGlobalX` already applied. The closest alternative.
- **The handler interceptor is added with `ApplicationConfig.addGlobalInterceptor`, not provided as
  `APP_INTERCEPTOR`**: once per app (two instances would add two), and no provider node of the
  inspector in the app's graph. It lands after the app's globals; its insertion rule places the
  handler step correctly at any position. `routes_*` leave it, and the trace middleware, out.
- **`injectables` and globals, not `providers`**: a service that happens to have `transform` or
  `catch` is not an enhancer and must not record steps; `APP_X` providers are reached through
  `ApplicationConfig`. Enhancer instances written inline in controller decorators are wrapped too.
- **One recorder per app** (keyed by its `ApplicationConfig`), not per process: two apps in one
  process keep their own buffer and options. The `AsyncLocalStorage` is per process.
- **`forRoutes('{*path}')` on Nest 11, `'*'` on Nest 10**: Nest 11 warns about `/api/*` under a global
  prefix (`LegacyRouteConverter`); Nest 10's path-to-regexp knows only `*`.
- The middleware is a class created per app: Nest names a functional middleware with a random token.
- `request_trace` also takes `scope`, like the other tools. `nest-mcp.bootstrap.ts` and
  `app.tools.ts` did not change (`app_info.tools.requests` turns `true` through the registry).

### Hot decisions

- **Open decision 1 closed: no alias for an existing correlation header.** One header is read,
  `requests.idHeader`; an app that already propagates `x-request-id` sets it to that. An alias by
  default would turn ids a proxy generates into trace ids, and two headers need a precedence rule.
- A guard returning `false` is `denied`; a guard that throws is `threw` with the exception (401 from
  `ApiKeyGuard` is `threw UnauthorizedException`).
- Steps are in the order they were recorded; the handler step spans from the end of the step before
  it to the first inner `exit`, so it is the handler's own time, not the interceptors'.
- Traces enter the buffer when they start, so in-flight requests show (`inFlight: true`).
  `requests_list` answers oldest first, like `logs_tail`. Several traces with one id: the latest.
- A module-scoped instance sees a trace only if its route's module is in scope; a request that matched
  no route is seen from app scope only. Without `snapshot` there is no `level`, `module` or scope
  filter (scope falls back to app, as before).
- The first instance of an app with the group on decides `requests.*`; later ones only exclude their
  endpoint.

### Stumbles and resolutions

- Nest's `GuardsConsumer` checks `instanceof Observable` on a guard's result: lifting with `pipe(tap)`
  keeps the source's own Observable class, so the check holds whatever `rxjs` copy the package loads.
- A wrapped interceptor gets a `next` derived with `Object.create(next)`, whose `handle` records that
  it was called; everything else on `next` is inherited.

### Critical information for later phases

- **Phase 6**: `wrapEnhancers` walks `ModulesContainer` (`injectables`, `controllers`); events and jobs
  walk providers. The note to extract `forEachInstance` into `support/` still stands, and so does the
  getter-by-name read of `ApplicationConfig` globals, now in `routes-reader.ts` and
  `wrap-enhancers.ts`.
- **Phase 6b**: the Nest 10 leg is the first run of `'*'` for the middleware, of
  `addGlobalInterceptor` and of `InstanceWrapper.isTransient`/`isDependencyTreeStatic` there.
- **Phase 7**: global enhancers added after `app.init()` are not traced; nor are requests outside the
  global prefix. Frozen enhancer instances are left unwrapped.
- Not covered by a test: aborted requests (`close` before `finish`), async `intercept`, and a
  `TRANSIENT` enhancer on a real app (the walk's branch has a unit test).

### Verification

- `yarn test` at start: 10 suites, 105 tests green, before any change.
- `yarn build && yarn test`: 12 suites, 133 tests green; `test/requests.spec.ts` (21) covers the
  happy path, denial, pipe failure, filter, ten concurrent requests, the injected-guard transparency,
  correlation without echo, the three `headers` modes with a body never stored, `forFeature` scope,
  the endpoint excluded and `tools.requests: false` leaving no mark.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.

## Phase 4 — Live logs from the app's `Logger` (2026-10-25)

**Work commit:** `a82aadc` (ticket #6).

### Done

- `RingBuffer<T>` (`src/support/ring-buffer.ts`): fixed size, drops the oldest, numbers entries with
  a growing `seq` from 1; `push`, `all`, `since(seq)`, `last(n)`, `size`, `length`, `lastSeq`.
- `LogTee` (`src/logs/log-tee.ts`): forwards `log`, `error`, `warn`, `debug`, `verbose`, `fatal`
  and `setLogLevels` to the app's logger exactly as called (optional methods only if present) and
  copies `{ timestamp, level, context, message, stack? }` to the buffer, splitting context and stack
  the way `ConsoleLogger` does. `installLogTee` (`src/logs/install-log-tee.ts`) installs it once per
  process with `Logger.overrideLogger` and returns the active tee to every later instance.
- `logs_tail` (`limit`, `level`, `minLevel`, `context`, `contains`, `sinceSeq`, `scope`) and
  `logs_levels`, switched by `tools.logs`; a `forFeature` instance filters by the class names of its
  closure used as context, and says so in `scopeFilter`.
- Fixture `LoggingService` (opt-in `logging`), `MemoryLogger` in the harness (`RecordingLogger`
  extends it), `test/log-tee.spec.ts`, `test/logs.spec.ts` with a `nestjs-pino` app; "Logs" section
  and limitations in the README.

### Deviations from the plan

- **Installed at `onModuleInit`, not `onApplicationBootstrap`** (closed decision 9). Nest runs
  `onApplicationBootstrap` deeper modules first, so the fixture's `LoggingService` (and any app
  module that logs at bootstrap) wrote before the inspector's hook. `onModuleInit` is still after
  `useLogger` in a normal bootstrap, and before every `onApplicationBootstrap`; only `onModuleInit`
  hooks of modules initialised before the inspector's are missed. The closest alternative.
- **No logger (`logger: false`) is not replaced by a new `ConsoleLogger`**: the tee wraps nothing,
  forwards nothing and still copies. Wrapping a `ConsoleLogger` would print logs the app silenced.
  The `ConsoleLogger` is used instead when the active logger is a plain `new Logger()`, which would
  otherwise loop back into the tee.
- `app.tools.ts` did not change: `app_info.tools.logs` turns `true` through the registry.
- `nestjs-pino` is pinned to `^4.4` (with `pino` 9, `pino-http` 10) as a test devDependency: 5.x
  requires Nest 11 and the CI matrix runs Nest 10.

### Hot decisions

- A level the inner logger reports as disabled (`isLevelEnabled` returns `false`) is forwarded but
  not copied, so the buffer mirrors what the logger keeps; loggers without `isLevelEnabled` are
  copied in full and `logs_levels.levels` is `null`.
- Paging: without `sinceSeq`, `logs_tail` answers the newest `limit` matches; with it, the oldest
  `limit` after it, `more: true` when cut, and `lastSeq` is the last returned `seq` (cut) or the
  buffer's newest (not cut), so filtered-out entries are not rescanned. `dropped` counts entries
  after `sinceSeq` the buffer already lost.
- An `Error` as message is stored by its `message`, with its `stack` in `error` entries.
- The first instance that installs the tee decides `logs.bufferSize`; a later `useLogger` or another
  app in the process replaces the tee and the next install wraps the new logger with a new buffer.
- The tee is recognised by `Symbol.for('@jsirp/nestjs-mcp/log-tee')`, so two copies of the package
  never wrap each other.

### Stumbles and resolutions

- Nest's instance `Logger.error(message)` with a context sends `(message, undefined, context)`; the
  split treats a trailing `undefined` before the context as "no stack".
- With Nest's default logger, `Logger` instances print through their own local `ConsoleLogger`;
  once the tee is the static logger they print through the shared default one, so a per-instance
  `timestamp: true` loses its elapsed-time suffix. Documented in the README.
- `bufferLogs: true` lines flushed by `useLogger` come before the install and are not copied.

### Critical information for later phases

- **Phase 5** reuses `RingBuffer` and the idempotent install pattern (a `Symbol.for` marker plus
  "return the active one"). `NestMcpBootstrap` now has `onModuleInit` for the tee; enhancer wrapping
  belongs where container instances exist.
- **Phase 6b**: `Logger.staticInstanceRef` and the `ConsoleLogger` split rules were read on Nest 11;
  the Nest 10 leg is their first check (`fatal` is optional in the tee for that reason).
- **Phase 7**: hosts that log mostly through `pino-http` will see few entries; that is expected.

### Verification

- `yarn test` at start: 8 suites, 84 tests green, before any change.
- `yarn build && yarn test`: 10 suites, 105 tests green; `test/logs.spec.ts` (12) and
  `test/log-tee.spec.ts` (9) green, including the `nestjs-pino` app. A mutation that altered a
  forwarded argument made the transparency test fail.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.

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
