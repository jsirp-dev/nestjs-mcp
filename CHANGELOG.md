# Changelog

Development logbook of `@jsirp/nestjs-mcp`: one entry per closed phase, with fixed fields (done,
deviations from the plan, hot decisions, stumbles and resolutions, critical information for later
phases, verification, final commit). The phased plan is in [`docs/plans/`](docs/plans/).

Entries are in reverse chronological order. Each phase closure adds its block following the
two-commit convention (commit 1 = work, commit 2 = this entry).

Release notes for npm (`## 0.1.0`, …) are added above the logbook starting with the first release.

## 0.1.1 (2026-10-26)

Documentation only; no code changes.

- **Install as a regular dependency.** The README recommended `npm install --save-dev`, but the app's
  `AppModule` imports the package, so a production install without devDependencies failed at startup
  with `Cannot find module '@jsirp/nestjs-mcp'`. The README now says to install it as a dependency
  (it is inert in production: `enabled` defaults to `false` there) and shows how to keep it in
  devDependencies with an import behind a `NODE_ENV` check.
- **Contents** section at the top of the README.

## 0.1.0 (2026-10-26)

First release. `@jsirp/nestjs-mcp` embeds in a running NestJS app an MCP inspector that tells a coding
agent what Nest actually built and what the app is doing. Add `NestMcpModule.forRoot()` (and
`snapshot: true` in `NestFactory.create`), then point the agent at `http://127.0.0.1:7777/`. Full
guide in the [README](README.md).

### What it gives an agent

- **`app`**: `app_info`, versions, scope, which tool groups are live and the inspector's URL.
- **`graph`**: `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles`
  over Nest's serialized graph; declared imports apart from implicit global-module links.
- **`routes`**: `routes_list`, `route_get`, every route with its guards, interceptors, pipes and
  filters in execution order (global, controller, method) and the middlewares that match it.
- **`logs`**: `logs_tail`, `logs_levels`, a transparent copy of what Nest's `Logger` writes, plus the
  host's own logger (pino, winston…) through `createLogSink()`. Each line carries the request or run it
  was written in.
- **`requests`**: `requests_list`, `request_trace`, the steps a request went through (guards,
  interceptors, pipes, handler, filters) with outcome and timing, and its log lines. The agent sets
  the `x-nest-mcp-request-id` header and asks for the trace afterwards; no streaming.
- **`events`**: `events_listeners`, `events_recent` (with `@nestjs/event-emitter`); emissions without
  payloads.
- **`schedule`**: `schedule_jobs` (with `@nestjs/schedule`), each job with its next and last run.
- **`runs`**: `runs_list`, `run_get`, each execution of a scheduled job or event listener with its
  outcome, error and log lines.
- **`debug`** (off by default): failing steps and runs carry the stack mapped to the original source
  and, with `debug.locals`, the local variables at the throw, bounded and read without running app
  code (ADR-0005).

### How it runs

- Its own HTTP listener inside the process (Streamable HTTP, stateless), `127.0.0.1:7777` by default:
  nothing of the app (prefix, versioning, middlewares, global guards or interceptors) runs in front
  of it. `listen` and `authorize(req)` for anything beyond loopback.
- Off when `NODE_ENV` is `production` unless `enabled` says otherwise; one `forRoot` for the whole
  app and any number of `forFeature` instances scoped to a module and its imports.
- Read-only: it observes the app and never calls its business code (ADR-0003).

### Requirements and limits

- Node 20 or later; `@nestjs/common` and `@nestjs/core` 10 or 11 as peers; Express. Fastify is not
  supported in v1, and clients that only speak stdio cannot connect.
- Consume it from npm; a checkout listed as a workspace of a host monorepo is not supported.
- Everything lives in memory, in bounded buffers; nothing is stored across restarts. Request bodies
  and event payloads are never stored. See the README's Limitations.

## Phase 7 — Host validation and first publication (2026-10-26)

**Work commit:** `30d63cd` (release preparation, ticket #12); version commit `8c7e012` (`v0.1.0`).

### Done

- Validated against a real host twice (ticket #11), on a Nest 11 app (global prefix, URI versioning,
  `nestjs-pino`) and a Nest 10 app (`@nestjs/swagger` 7). The first run filed #13 to #22, the second
  #29 and #30; all were fixed before the release, and #11 was closed with every acceptance criterion
  observed on both hosts.
- `0.1.0` release notes in `CHANGELOG.md`, README status set to the first release, `mcpName` in
  `package.json`, `server.json` for the MCP Registry. Open decisions 2 (Fastify) and 3 (resources and
  prompts) parked for v1.x.
- `@jsirp/nestjs-mcp@0.1.0` published by `release.yml` from the `v0.1.0` tag, with an SLSA v1
  provenance statement; the GitHub release carries the `0.1.0` notes. 16 files in the tarball.
- Listed in the official MCP Registry as `io.github.jsirp-dev/nestjs-mcp` 0.1.0 (status active).

### Deviations from the plan

- **ADR-0004 superseded the endpoint described in the phase document**: own listener instead of a
  controller, so `guards`, `localOnly`, `/api/_mcp` and the "disabled endpoint answers 404" check no
  longer apply. The phase document carries a note.
- **Fixes did go through corrective tickets, as the plan asked**, but between the two host runs and
  the release, not in later phases: tickets #13 to #30, logged under the heading below.

### Hot decisions

- **Listed in the MCP Registry despite the fit**: the registry expects servers a client installs and
  starts; this package runs inside the host app, so a client gets nothing from it unless the app
  mounts it. `server.json` declares a streamable-http package at `http://127.0.0.1:7777/` and the
  description says it is embedded. Watch for issues from people who try to start it on its own.

### Stumbles and resolutions

- **`npm version` inside a host monorepo**: npm found the host's workspaces and, after creating the
  commit and the tag, tried to resolve the whole host tree and failed with an unrelated peer conflict.
  The commit and tag were right. Next time, run `npm version <x.y.z> --workspaces=false` there.
- **npm processed the first publish for a few minutes**: meanwhile the registry showed a `0.0.0-stage`
  placeholder version, which stays listed next to `0.1.0`; `latest` points at `0.1.0`.
- **MCP Registry and organisation namespaces**: `mcp-publisher login github` (device flow) only grants
  `io.github.<user>/*`; publishing under `io.github.jsirp-dev/` needs an organisation Owner and a
  credential that can read the org role. `mcp-publisher login github --token "$(gh auth token)"`
  worked (the `gh` token has `read:org`). Publishing from GitHub Actions with OIDC is the alternative
  for later releases.

### Critical information for later work

- Hosts consume the package from npm. In a host monorepo that embedded the submodule as a workspace,
  switch the app to `@jsirp/nestjs-mcp@^0.1.0`, take the submodule out of the workspaces and drop the
  Nest `resolutions` that worked around the second copy.
- Known limits carried into 0.1.0 (README, Limitations, and the CHANGELOG entries below): log lines
  written from `res.on('finish')` after a lost async context have no `requestId`; guards that return
  an Observable have the same gap #29 closed for interceptors; `logs_levels.levels` is `null` with
  `logs.capture: 'sink'`.

### Verification

- `release.yml` run 40309979403 green: CI matrix (Nest 10 and 11 × Node 20 and 22), `npm publish
  --provenance`, GitHub release.
- `https://registry.npmjs.org/@jsirp%2fnestjs-mcp/0.1.0`: version `0.1.0`, `mcpName`
  `io.github.jsirp-dev/nestjs-mcp`, provenance predicate `https://slsa.dev/provenance/v1`, 16 files.
- `https://registry.modelcontextprotocol.io/v0.1/servers?search=nestjs-mcp`: one server,
  `io.github.jsirp-dev/nestjs-mcp` 0.1.0, status active.

### Project closed

The plan of `docs/plans/` is complete. New work comes in as issues in `jsirp-dev/nestjs-mcp`, starting
from the known limits above.

---

## After the first host validation (tickets #13 to #30, released in 0.1.0)

### Anonymous async frames keep the path alone in `file` (ticket #30, 2026-10-26)

#### Done

- `src/debug/stack-frames.ts`: a frame V8 writes as `at async /path/file.js:43:31` (no name, no
  parentheses) gives `function: "async <anonymous>"` and `file: "/path/file.js"`, with its line and
  column; before, `async ` stayed at the start of `file`. A `file:` URL in that position becomes a
  path, as elsewhere. The frame is then flagged and mapped like any other: in `node_modules` it is
  `external`; in the app's compiled code it is mapped through the file's source map.
- README (`debug`, the `stack` notes): what `function` holds, the anonymous async frame among them.

#### Hot decisions

- **`async <anonymous>`, not `<anonymous>`**: the issue allowed either; keeping the marker treats
  the frame as `async Foo.bar` frames are (the marker stays in `function`) and keeps telling an
  awaited call from a synchronous one.

#### Stumbles and resolutions

- **A real stack has to come from a child process**: in the test, ts-jest downlevels the test's own
  async functions, and Jest's stack formatting drops the `async` marker even from code compiled as
  written (`vm`). The test runs a two-line script with `node` and parses what it prints; the
  script's path goes through `realpathSync`, since the temporary folder of macOS is a symlink
  (`/var` → `/private/var`) and Node reports the real path.

#### Verification

`test/stack-frames.spec.ts`: the frame-forms test gains `at async
/app/node_modules/@nestjs/core/router/router-execution-context.js:43:31` (→ `async <anonymous>`, that
file, 43, 31, `external`) and `at async file:///app/dist/esm.mjs:9:8` (→ `/app/dist/esm.mjs`); a new
test parses the stack of the issue's repro run by `node` (`at async <file>:2:16` → `{ function:
'async <anonymous>', file, line: 2, column: 16 }`); another maps `at async <dist>/cats.js:1:5`
through `cats.js.map` to `src/cats.ts:3:7`, `mapped: true`. All three red before the fix (`file:
"async …"`). `yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (26
suites / 308 tests) green on Nest 11.2.8 and on Nest 10.4.22 (scratch copy), Node 20.19.4 and
22.18.0.

### Interceptors' exit phase kept in the trace after a lost async context (ticket #29, 2026-10-26)

#### Done

- After a middleware that loses the async context (multer before 2.3), what an interceptor runs
  after `next.handle()` keeps the request's trace, as with a JSON body: its log lines carry the
  `requestId` (`request_trace.logs`, `logs_tail({ requestId })`), and the listeners it triggers are
  recorded as runs with the `requestId`.
- The interceptor wrapper (`src/requests/wrap-enhancers.ts`) returns the interceptor's Observable
  through `subscribedInTrace`: a `lift` whose operator subscribes the source inside the trace's
  async context (`enterTrace`, new in `src/requests/trace-context.ts`, a no-op when already in it).
  Values, error, completion and unsubscription are the source's own; each subscription subscribes
  the source again; the source's Observable class is kept, as `pipe` keeps it.
- README: the "Traces by wrapping enhancer instances" paragraph says the Observable is subscribed
  inside the trace; the `requestId` paragraph lists the limit below.

#### Hot decisions

- **The cause, confirmed before the fix**: a probe in the wrapper logged the store at the moment
  the returned Observable was subscribed: `json-1` for the JSON request, `undefined` for the
  multipart one. Nest's router subscribes to what the interceptors return (and awaits it) in the
  context the request arrived in; `next.handle()` turns the handler's Promise into an Observable
  whose `then` is attached at subscription, so its emission, and every operator after it, ran in
  the lost context. Re-entering the context on subscription is the issue's suggested remedy.
- **Lines written once the response is sent stay out**, documented as a limit (README, `requestId`
  paragraph): a probe middleware placed before multer with `res.on('finish', …)` writing through
  Nest's `Logger` gives `finished@json-1` and `finished@undefined`. Nest's router ends the response
  after an `await`, back in the lost context, and Node emits `finish` there. Covering it would mean
  patching the response object (`end` or `emit`), which the inspector does not do. pino-http's
  `request completed` is such a line.
- **`lift`, though rxjs 7 marks it an internal detail** ("will be made internal in v8"): every
  rxjs 7 operator goes through it (`operate`), it keeps the source's Observable class, and the peer
  range is `^7`. Building the result with `new observable.constructor(…)` would break when the
  interceptor returns a `Subject` (piping it gives an `AnonymousSubject`, whose constructor takes
  other arguments); `new Observable(…)` from the package's own `rxjs` would drop the source's class.
- **Interceptors only**: a guard that returns an Observable is subscribed by Nest after
  `canActivate` returns, in the same lost context; the step is still recorded (the wrapper's `tap`
  closes over the trace), only lines logged inside that Observable miss the id. Not reported; noted
  below.

#### Notes for the next session

- `observe` in `src/requests/wrap-enhancers.ts` could pass guard Observables through
  `subscribedInTrace` too, if a host reports lines missing from an Observable guard.

#### Verification

`test/multipart.spec.ts`, new test (fixture `uploadAfter: true` with `events: true`:
`AfterUploadModule` puts multer in front of `POST /after`, whose `AfterInterceptor` logs before the
handler and, in a `tap` after `next.handle()`, logs and emits `upload.done`; `AfterListener` logs):
`json-1` and `multipart-1` both list `before handle`, `in handler`, `after handle`, `listener ran`,
all with their own `requestId`; `runs_list({ name: 'AfterListener.onDone' })` gives the requestIds
`['json-1', 'multipart-1']`; `logs_tail({ context: 'AfterInterceptor' })` gives `after
handle@multipart-1`. Red before the fix (`after handle` and `listener ran` missing from the multipart
trace). `test/wrap-enhancers.spec.ts`, new test: an interceptor whose `tap` reads `current()`,
subscribed outside its trace, sees `'t'` on both emissions; the result is an `Observable`, values
pass as they are, unsubscribing tears the source down, each subscription subscribes the source again,
errors pass through; red without the fix (`[undefined, undefined]`). `yarn format-check`,
`yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (26 suites / 306 tests) green on
Nest 11.2.8 and on Nest 10.4.22 (scratch copy), Node 20.19.4 and 22.18.0.

### npm-only consumption, Nest dev ranges, `.turbo/` (tickets #15, #16, #17, 2026-10-25)

#### Done

- **#15:** the README (Install) says the package is consumed published on npm, and that listing a
  checkout as a workspace of a host monorepo is unsupported, with the two reasons: the own `yarn.lock`
  makes Yarn treat the folder as a separate project, and the devDependencies would bring a second Nest
  that breaks the host's injection. `CLAUDE.md` (Local setup) no longer tells sessions to run the
  scripts through a host's package manager; decision 16 of `00-overview.md` carries the same line. The
  `yarn.lock` stays.
- **#16:** `.turbo/` in `.gitignore`.
- **#17:** the devDependency ranges of `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express`
  go from `^11.1.0` to `^11.0.0`. `yarn.lock` only renames their descriptors: all three still resolve
  to 11.2.8. The peers are unchanged.

#### Hot decisions

- **Documentation, not removal, closes #15**: the owner decided the package is consumed from npm,
  whose tarball holds only `dist/`, README, CHANGELOG and LICENSE and never installs devDependencies,
  so neither problem reaches a consumer. Dropping the lock would break `yarn install --immutable` in
  CI and reproducible standalone development.

### Function middlewares named instead of Nest's random token (ticket #21, 2026-10-25)

#### Done

- `route_get.middlewares` lists a function middleware (`consumer.apply((req, res, next) => next())`,
  a named function, `nestjs-pino`'s two) as `<functional middleware from Module>`, after the module
  whose `configure` applied it (`<functional middleware>` if that module is not in the graph), instead
  of the 21-character token Nest names its class with. Class middlewares keep their name.
- Each function middleware is listed once per route; two of them no longer depend on their tokens to
  stay apart. A class is still listed once by its name, as before.
- The shape of `middlewares` is unchanged (`string[]`): not a breaking change.
- README (`route_get` notes), the `route_get` description, `RouteModel.middlewares`.

#### Hot decisions

- **The function's own name cannot be recovered without running the app's code**: in Nest 10.4.22
  and 11.2.8 alike, `MiddlewareConfigProxy.forRoutes` passes the list through `filterMiddleware`,
  whose `mapToClass` wraps each function in an anonymous class that sets `use` in its constructor
  (a closure over the function) and names it with `uid(21)`. Only the wrapped classes are kept, in the
  builder's configurations and the middleware container; the original function is reachable only from
  that closure. Reading it would mean instantiating the class and calling `use`, or patching
  `MiddlewareConsumer`, both ruled out, so the issue's stable marker is used, with the module added
  (it tells a third-party middleware from the app's own).
- **How a function middleware is told apart**: its graph node's token is a class without `use` on the
  prototype whose name is 21 hex characters. A class middleware has `use` on its prototype (a
  `MiddlewareHost` from `exclude()` too); one that declares `use` as a field still keeps its own name.

#### Stumbles and resolutions

- **Order across majors**: the entrypoints come out of the graph grouped by middleware, not in the
  order Nest runs them, and Nest 10 and 11 interleave them differently. Already so before this change;
  the new tests sort before comparing.

#### Notes for the next session

- `graph_module` / `graph_class` still show a function middleware's class by its random label; the
  same detection would apply there.

#### Verification

`test/routes.spec.ts`, 2 new tests, both red before the change (random tokens in the list):
`FunctionalMiddlewareModule` (fixture `functionalMiddleware: true`: an arrow function and the named
`stampRequest`, `forRoutes('*')`) next to `TraceMiddleware` gives two
`<functional middleware from FunctionalMiddlewareModule>` and `TraceMiddleware`; `nestjs-pino`'s
`LoggerModule.forRoot()` (fixture `pino: true`) gives two `<functional middleware from LoggerModule>`.
A repro script on `dist/index.cjs` (an arrow, a named function and `nestjs-pino`) gives four markers,
two per module, on Nest 11.2.8 and 10.4.22. `yarn format-check`, `yarn lint`, `yarn type-check`,
`yarn build`, `yarn test` (26 suites / 304 tests) green on Nest 11.2.8 and on Nest 10.4.22 (scratch
copy).

### Implicit global-module links out of `imports` and cycles (ticket #14, 2026-10-25)

#### Done

- `graph_module.imports` and `graph_modules[].imports` list only what a module declares. The links
  Nest adds from every module to every global module go to a new `graph_module.globals`
  (`InternalCoreModule` among them under `includeInternal: true`); a global module the module does
  declare stays in `imports`. `importedBy` lists the modules that declare the import.
- `graph_cycles` leaves the implicit links out, so global modules no longer form one large "module
  cycle" with whatever imports them; `forwardRef` cycles are still reported.
- The model: `GraphModule.globals`, and `implicit: true` on those `module-to-module` edges.
  `GraphReader` takes the `ModulesContainer` as a second source (the tool context injects it).
- README (graph tools table and notes, the `forFeature` scope paragraph), `GLOSSARY.md` (*scope*).

#### Hot decisions

- **How implicit links are told apart**: the serialized graph does not mark them (Nest 10.4.22 and
  11.2.8 checked: the edge metadata is only `type` and both module names), and the edges come out of
  `toJSON()` in key order, not insertion order. A module's `imports` set in the `ModulesContainer`
  does keep insertion order: first what the module declares, while scanning; then, from
  `bindGlobalScope`, every global module it lacks, `InternalCoreModule` always first (Nest
  registers it before scanning the app, and no app module declares it). So the links from
  `InternalCoreModule` on are implicit. A declared global module is already in the set by then, so
  it keeps its place and counts as declared. Same order in both majors. Without the container,
  every edge would count as declared, as before.
- **The `forFeature` scope is unchanged** (ticket #4): it still takes in every global module and
  what each imports, now by following `imports` and `globals`. A module can inject what a global
  module exports without declaring it, so those providers are part of what it sees. Importers of
  the instance are still found by declared imports only.
- **`globals` only in `graph_module`**, not in each `graph_modules` entry: it is the same list for
  almost every module and would repeat it for each.

#### Stumbles and resolutions

- **The `ModulesContainer` member of the reported cycle was not reproduced**: module cycles only
  ever take nodes of type `module`, and neither the fixture nor a probe app with `DiscoveryModule`,
  `EventEmitterModule` and `ScheduleModule` gives a module node with that label. With the implicit
  links out, the cycle it was part of cannot form; a test checks that every cycle member is a module
  `graph_modules` lists.

#### Verification

`test/global-imports.spec.ts` (5 tests, fixture `globals.module.ts`: `GlobalAModule` imports
`GlobalBModule`, both `@Global()`; `FeatureModule` imports neither; `DeclaringModule` declares
`GlobalBModule`; `LoopAModule` ↔ `LoopBModule` by `forwardRef`; with `EventEmitterModule` and
`ScheduleModule`): `FeatureModule` has `imports: []` and the four globals in `globals`; `GlobalAModule`
has `imports: ['GlobalBModule']`; `DeclaringModule` keeps `GlobalBModule` in `imports`;
`InternalCoreModule` is in `globals` with `includeInternal`; `graph_cycles` gives only
`[LoopAModule, LoopBModule]`; a `forFeature` instance in `FeatureModule` keeps both globals in its
scope; all five were red before the change. `test/scope.spec.ts` gains a test for the closure
through `globals`; removing `globals` from the closure turns it and the `forFeature` test red.
`test/graph.spec.ts`: `CatsModule` no longer lists `InternalCoreModule` in `imports`. A repro script on `dist/index.cjs` (the issue's two globals plus a feature) gives the same answers
on Nest 11.2.8 and 10.4.22. `yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`,
`yarn test` (26 suites / 302 tests) green on Nest 11.2.8 and on Nest 10.4.22 (scratch copy), Node
20.19 and 22.18.

### Local variables at the throw, under `debug` (ticket #26, 2026-10-25)

#### Done

- [ADR-0005](docs/adr/0005-local-variables-read-under-debug.md) (its own commit): under `debug`,
  and only then, the inspector reads the values of local variables at a throw; read, never
  evaluated. `00-overview.md` closed decisions 5 and 11 carry the exception.
- New option `debug.locals: boolean | { frames?, depth?, properties?, stringLength?, bytes?,
  perMinute? }`, on by default with `debug` (defaults 5, 2, 20, 200, 16384, 10); `false` keeps the
  stacks of #25 without starting anything.
- `TraceError` gains `locals: FrameLocals[]` (`{ function, file, line?, external?, scopes?: {
  local, closure } }`), aligned with `stack`, plus `localsTruncated: true` when the byte budget cut
  the capture and `localsSkipped: 'rate' | 'ambiguous'`. On the failing step of a trace and on the
  error of a run.
- The capture: `src/debug/locals-worker.ts`, built by tsup as its own entry
  (`dist/locals-worker.{js,cjs}`, next to the bundle, in the bundle's format), runs a
  `node:inspector` session connected with `connectToMainThread()`: debugger enabled with
  breakpoints inactive, pause on every exception. On a pause it resumes at once unless a trace or
  run is in flight (a counter in a `SharedArrayBuffer` the recorder and the run wrapper keep), the
  exception is an `Error`, the top frame is the app's (not `node_modules`, `node:`, a script
  without a file or this package's own directory) and it is not a rethrow from a `catch` block of
  the caught error; then, within the rate, it reads the scopes with `Runtime.getProperties` (own
  properties only) into a bounded preview (`src/debug/locals-preview.ts`), posts it on a
  `MessagePort` and resumes. `src/debug/locals-capture.ts` starts and stops the worker, drains the
  port synchronously with `receiveMessageOnPort` when an error is described and pairs the capture
  with the error by its stack text.
- `app_info.debug.locals: { state: 'off' | 'starting' | 'ready' | 'failed', error?, captured,
  skippedRate }`; `options.debug` shows the resolved bounds. A worker that cannot start logs one
  `warn` at bootstrap and stacks go on without locals.
- The app's bootstrap (`onApplicationBootstrap` of the inspector) waits, at most 5 s, for the
  session to be armed, so the first request is captured; `onModuleDestroy` of the last instance
  terminates the worker.
- README (options, "Locals at the throw", How it works, Security, Limitations, Runs), `GLOSSARY.md`
  (*locals*, *frame*), `00-overview.md` (the option). Exported types `NestMcpLocalsOptions`,
  `FrameLocals`, `LocalValue`, `LocalObject`, `LocalScopes`.

#### Measured overhead

`bench.cjs` (scratch, not in the repo): a Nest app on the built package, `fetch` to its own server,
400 requests after 20 of warm-up, median and p90 in µs; and a loop of 20 000 `throw`/`catch` in app
code with nothing in flight. M-series Mac, Nest 11.2.8.

| | Node 20.19 | Node 22.18 |
|---|---|---|
| Request that throws, `debug` off | 421 (p90 568) | 412 (p90 610) |
| Same, `debug: { locals: false }` (stacks only) | 434 (p90 587) | — |
| Same, locals captured (2 frames of app code, an object, a 500-char string) | 2252 (p90 2592) | 2178 (p90 2515) |
| Request that does not throw, locals on | 451 (p90 666) | 430 (p90 632) |
| One `throw`/`catch` with nothing in flight, off | 2.0 | 1.6 |
| Same, locals on (the pause the worker resumes without reading) | 136 | 131 |

So **about 1.8 ms per captured exception** and **about 0.13 ms per exception the worker filters
out**: the round trip of a pause to the worker and back, paid by every exception in the process
while locals are on. A request without exceptions costs the same.

#### Deviations from the ticket

- **Correlation by stack text, not by request id**: the trace lives in an `AsyncLocalStorage`, which
  a paused frame cannot reveal without running code. The worker gates on "a trace or run is in
  flight" (shared counter) and keys each capture by the exception's description, which is its
  `stack`; the main thread claims it when it describes that error. Two pending captures under the
  same key are not guessed between: `localsSkipped: 'ambiguous'` (ADR-0005).
- **`localsSkipped` has a second value**, `'ambiguous'`, for the case above.
- **Runs get locals too** (the ticket's crons criterion let the ADR decide): a run opens the same
  window as a trace, so excluding runs would have read them anyway whenever a request was in
  flight. Exceptions with nothing in flight (startup, timers) are never read.
- **Getters are named, not dropped**: an accessor shows as `[Getter]` (never called), so the agent
  knows the property exists; data properties are the only values read.
- **The 11th error of the minute is already skipped**: with the default rate of 10, the 11th and
  12th get `localsSkipped: 'rate'` (the ticket's criterion names the 12th).

#### Hot decisions

- **The worker is a file of its own**, not inline code (`eval: true`): esbuild rewrites `require`
  and helpers in an ESM bundle, so a stringified function would not survive the build. tsup emits
  it next to `index` in both formats; the main bundle resolves it with `__filename` (shimmed in
  ESM) and its own extension. It starts with `execArgv: []` (no preload hooks of the app) and a
  64 MB heap limit, and is `unref`'d.
- **Breakpoints inactive in the session** (`Debugger.setBreakpointsActive(false)`): otherwise a
  `debugger` statement would stop an app that has no debugger attached. Pauses whose reason is not
  `exception` or `promiseRejection` are left alone, so another debugger's breakpoints still work.
- **Locals on the first step only**: every step that records the same exception (the handler, the
  interceptors it crosses, the filter that catches it) shares one `locals` array; `request_trace`
  shows it on the first of them, the one that threw. The stack stays on all of them, as in #25.
- **Rethrows**: a pause whose top frame has a `catch` scope holding an error with the same stack
  text is the app rethrowing what it caught; it is skipped, so the first throw keeps its locals and
  the rate is not spent twice. A rethrow from a promise's `catch` handler is not detected.
- **Pairing state is bounded**: at most 64 stack texts pending, the two latest captures under each,
  dropped after 5 s unclaimed; a capture may take at most 200 ms of the main thread's pause before
  reading stops.
- **The positions of `locals` come from `stack`** when both name the same function at the same
  index (the usual case, and the only one where ts-jest's own source maps agree); otherwise from the
  paused frame, mapped through the same `SourceMaps`.

#### Notes for the next session

- The 0.13 ms per filtered exception is the floor of the "pause on all exceptions" design; arming
  the session only while something is in flight would remove it but races the first exception of a
  request (the toggle is asynchronous). Worth a ticket only if someone runs `debug` under load.
- **Another debugger attached**: with VS Code attached and "pause on caught exceptions" on, the worker
  resumes those pauses (README, Locals at the throw). Nothing detects it.

#### Verification

`test/debug-locals.spec.ts` (14 tests, fixture handlers `locals`, `locals-async`, `recovers`,
`rethrows` in `FailingModule`; `JobsService.purge` gains a local): `total: 42` in the top frame of
`FailingController.locals`, aligned with `stack[0]`; an async handler's local after `await`; the
local object's getter never called (`getterCalls.count` stays 0, shown `[Getter]`), the 1 MB string
cut to 200 characters plus its length, depth 2, the whole `locals` within 16 KB; bounds from the
object form and `localsTruncated` under `bytes: 300`; 12 failing requests: 10 with locals, the 11th
and 12th `localsSkipped: 'rate'`, `app_info` `captured: 10, skippedRate: 2`; an exception thrown
with nothing in flight is not read (`captured: 0`); a `ParseIntPipe` exception (node_modules) is not
read; a rethrow from `catch` keeps `descend`'s locals with one capture; the filter step that caught
the exception has its stack but no locals; a cron run's error has `batch: 3`; responses and status
codes of four routes identical with `debug` off and on; `Worker` never constructed with `debug`
off, `false` or `{ locals: false }` (`state: 'off'`); the worker exits on `app.close()`; a `Worker`
that throws gives `state: 'failed'`, one `warn`, stacks without locals. Red checks: without the
in-flight gate the "nothing in flight" test fails; without the rethrow check the rethrow test fails.
`test/locals-preview.spec.ts` (7 tests, a fake session): every kind of value (no function source
kept, a `Map` never entered), the scopes read and those never read, external frames listed and not
read, property and item limits, the byte budget, string truncation, the rethrow check. The ESM
build checked by hand (`dist/index.js` finds `dist/locals-worker.js`, `total: 42`) on Node 20 and
22. `yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (25 suites / 296
tests) green on Nest 11.2.8 (Node 20.19 and 22.18) and on Nest 10.4.22 (scratch copy, Node 20.19
and 22.18); `jest --detectOpenHandles` on the debug specs reports nothing.

### The `debug` option: source-mapped stacks on failing steps (ticket #25, 2026-10-25)

#### Done

- New option `debug: boolean | { stackFrames? }`, default `false` whatever `enabled` is, on
  `forRoot`, `forFeature` and their `*Async` factories. Process-wide like `logs`: the first instance
  whose module is configured sets it, every later one keeps it, and it is cleared when the last
  instance is destroyed, so an app created after another closed in the same process decides afresh.
- With it on, `TraceError` gains `stack: StackFrame[]`, each `{ function, file, line?, column?,
  mapped, external? }`, at most `debug.stackFrames` (default and maximum 30), from the throw
  outwards. It is on every error a trace records: the step that threw (guard, interceptor, pipe,
  handler, a filter that threw) and the filter step with the exception it caught.
- **Also on runs**: the error of a job or listener run is built by the same `describeError`, so
  `run_get` and `runs_list` carry the stack too, at no extra cost.
- Mapping, without a dependency (`node:module`): a stack Node already mapped
  (`--enable-source-maps`, `process.setSourceMapsEnabled`) is read as it is; otherwise each frame
  of a JavaScript file is looked up in Node's `findSourceMap` and, failing that, in the map the
  file's `sourceMappingURL` comment points to (a sibling `.js.map` or an inline `data:` URL), read
  once per file and cached (at most 1000 files). Sources are resolved against the map and its
  `sourceRoot`; `sourcesContent` is dropped before the map is built.
- `app_info` gains `debug: { enabled, stackFrames, sourceMaps: { process, files } }` (what the
  process runs: whether Node maps stacks, and how many compiled files' own maps the inspector read)
  and `options.debug` (what this instance was given).
- `src/debug/`: `stack-frames.ts` (parser, `SourceMaps`), `debug.ts` (the process-wide state,
  `stackOf`, `debugStatus`). Exported types `NestMcpDebugOptions`, `StackFrame`, `DebugStatus`.
- README (options, the new "Debug: stacks of failing steps" section, `app_info`, Runs, How it works,
  Limitations), `GLOSSARY.md` (*frame*), `00-overview.md` (the option).

#### Deviations from the ticket

- **"On the step that threw, and on the trace"**: a trace has no error of its own (`RequestTrace`
  has no `error` field); the trace's errors are its steps'. Every one of them gets the stack,
  including the filter step's caught exception. No top-level field was added.
- **`stackFrames` is configurable downwards only** (1 to 30): the ticket fixes the bound at 30, and
  the object form needs at least one field until #26 adds its own.

#### Hot decisions

- **Parse `error.stack`, never install anything**: structured call sites exist only through a
  global `Error.prepareStackTrace` at the moment V8 formats the stack, which would change what the
  app's own stacks look like and fight `source-map-support`. Reading `error.stack` is what any
  logger does (Nest's `ExceptionsHandler` already does). `Error.stackTraceLimit` is not touched
  either, so the frames are as many as V8 captured (10 by default).
- **Map at record time, not when the tool answers**: the position is that of the code that ran; a
  watch-mode rebuild between the throw and the question would otherwise remap against new code.
- **`mapped` means "the position is the original source's"**: true when the inspector mapped it,
  and also for a file that is not JavaScript (`.ts`, `.tsx`…), which can only come from a stack the
  process mapped already (Node's source maps, `source-map-support`, jest) or from code run as it is.
  A `node:` frame and any `.js`/`.cjs`/`.mjs` position without a map are `mapped: false`.
- **External frames are not mapped**: `node_modules`, `node:`, and frames without a file
  (`<anonymous>`, `native`, `index 0`) are kept with the position V8 gave and `external: true`. It
  saves a file read per dependency frame, and the agent skips them anyway.
- **A source with another URL scheme** (`webpack://app/./src/main.ts`) is kept as written, not
  resolved into a path that does not exist.
- **Only `Error` instances get a stack** (`instanceof Error` is safe: it is not a Nest class). A
  thrown string or plain object keeps `{ name, message }`.

#### Notes for the next session (#26)

- `locals` goes next to `stack` in `TraceError`, aligned with it: `stack[i]` is the frame whose
  scopes `locals[i]` would hold. `stackOf()` in `src/debug/debug.ts` is the one place that decides
  whether a recorded error gets debugging data; the process-wide `active` options there are where
  `debug.locals` bounds belong. `ResolvedDebugOptions` and `resolveDebug` in
  `src/nest-mcp.options.ts` take the new fields; `NestMcpDebugOptions` is the object form.
- `installDebug`/`release` in `configure`/`onModuleDestroy` already give the lifecycle a worker
  thread needs: start it on the first install, stop it on the last release.
- Mapping happens inside `describeError`, synchronously, on the app's request path, but only with
  `debug` on; a file's map costs one read the first time a frame lands in it.

#### Verification

`test/stack-frames.spec.ts` (10 tests): every frame form V8 writes (named, location only,
`async`, `new`, `<anonymous>`, `node:`, `node_modules`, `file://` URLs), the frame limit, a `.ts`
position taken as mapped, garbage that does not throw, mapping through a sibling `.js.map` and an
inline map with `sourceRoot`, a `webpack://` source, missing, unreadable and absent maps, one read
per file and no `sourcesContent` kept, external frames left unmapped. `test/debug.spec.ts` (9
tests, new fixture `FailingModule`, opt-in `failing: true`): off by default the error keys are
exactly `name, message`; on, the handler's `stack[0]` is `FailingController.plain` at the fixture's
throw line; `ApiKeyGuard`'s throw and the `NotFoundFilter` step (its caught exception) and the
handler of the same request carry the stack; 60 recursive calls with `Error.stackTraceLimit = 100`
give 30 frames; `node:` and `node_modules` frames are `external: true` and no other is; the object
form's `stackFrames: 2`; `app_info.debug`; one instance decides for both instances of an app; a
cron run's error carries the stack; wrong shapes are rejected. `test/debug-compiled.spec.ts` (3
tests): the fixture `test/fixtures/compiled/app.ts`, compiled for real with `ts.transpileModule`
into a temp directory and run in a child process (ts-jest maps in-process stacks itself, so only a
child sees compiled ones): with its `.js.map`, `stack[0]` is the fixture's `.ts` at the throw line,
`mapped: true`, `sourceMaps.files: 1`; without a map, the compiled `app.js` at its own throw line,
`mapped: false`, nothing thrown; with `--enable-source-maps`, the `.ts` line and
`sourceMaps.process: true`. Red check: with the own-map lookup disabled, the first compiled test
fails (`app.js`, `mapped: false`). `yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`,
`yarn test` (23 suites / 275 tests) green on Nest 11.2.8 (Node 20.19 and 22.18) and on Nest 10.4.22 (scratch copy).

### Each run of a scheduled job or event listener is recorded (ticket #28, 2026-10-25)

#### Done

- A new tool group, `runs`, with its switch (`tools.runs`) and `runs.bufferSize` (default 500, one
  buffer per app): `runs_list({ kind?, name?, event?, outcome?, limit?, scope? })` and
  `run_get({ id, scope? })`. A *run* is one execution of a `@Cron`, `@Interval` or `@Timeout`
  method started by the scheduler, or of an `@OnEvent` method started by the emitter: kind, class,
  method, module, job name or emitted event, start, duration, outcome (`running`, `ok` or `threw`),
  the error's name and message, and `requestId` when it started inside a traced request. Never the
  payload or the arguments. The group is registered only when `@nestjs/schedule` or
  `@nestjs/event-emitter` is installed and its module imported.
- `run_get` lists the run's log lines (newest 200, `logsTruncated`, `logsDropped`) with the `logs`
  group on; log entries gain `runId`, and `logs_tail` a `runId` filter. `currentOrigin()` in
  `src/logs/log-origin.ts` now reads the run as well as the trace: an entry may belong to both,
  so the owners on an entry are a list.
- `schedule_jobs` gains `lastRun` (`{ id, startedAt, outcome, durationMs? }`) per decorated job and
  `events_listeners` per listener (matched by class, method, module and, for listeners, the
  pattern).
- `src/runs/`: `install-runs.ts` (the wrappers), `run-context.ts` (the run and emission
  `AsyncLocalStorage`s), `present.ts` (the answer shape and `lastRun`), `model.ts`.
- [ADR-0006](docs/adr/0006-runs-by-wrapping-job-and-listener-methods.md) (its own commit),
  README (Runs, How it works, Limitations, options, logs), `GLOSSARY.md` (*run*, the `runs` group),
  `00-overview.md` (the group and its option).

#### Deviations from the ticket

- **`schedule_jobs.lastRun` was taken**: it held the `CronJob`'s own `lastDate()` as a string. The
  ticket gives the name to the recorded run, so the cron's value is now `lastFiredAt`. The answer
  changes shape; nothing was released yet.

#### Hot decisions

- **An ADR, not a note**: ADR-0002 wraps enhancers, which only Nest's request pipeline calls. Job
  and listener methods are the app's own methods, each peer reads them at a different moment, and
  the app may call them itself; that took decisions of its own (ADR-0006).
- **Own property on the instance, not the prototype**, defined in `configure` (before any
  `onModuleInit`): `ScheduleExplorer` reads `instance[method]` at its `onModuleInit` and binds it
  for good; `EventSubscribersLoader` reads `instance[method]` at every emission. Both read the
  decorator metadata off the function, so the wrapper carries a copy of it.
- **Job wrappers are taken back at `onApplicationBootstrap`** (every `onModuleInit` ran by then):
  the scheduler keeps the wrapper it bound, while the app's own calls reach the original and are
  not runs. An own property the app had set is put back as it was.
- **A listener run needs an emission**: the runs group wraps `emit`/`emitAsync` once more (its own
  mark, independent of the `events` recorder) only to open an emission context with the event. The
  listener wrapper records only inside one whose event its declared pattern matches (through the
  emitter's own matcher, cached), so direct calls pass through and the run knows its event. With
  `tools.events: false` and `tools.runs` on, `emit` is therefore wrapped; the events spec now
  switches both off to check it is not.
- **A run is pushed when it starts, with `outcome: 'running'`**, and completed in place: a long
  job shows while it runs, and the lines it logs have a run to point to. The ticket names `ok` and
  `threw`; `running` is the in-flight state before either.
- **Only native promises are observed** for the end of a run: calling `then` on another thenable
  may start its work again (a lazy query). Anything else ends the run when the method returns.
- **Group name `runs`**, tools `runs_list` and `run_get` as the ticket proposed; the run id is a
  UUID; `runs_list` answers oldest first, the newest `limit`, as `events_recent` and `logs_tail` do.
- **`name` matches the decorator name or `Class.method`**: an unnamed job has only the id the
  registry generates, unknown when the wrapper is built.

#### Notes for the next session

- The line the scheduler (`Scheduler`) or the emitter loader (`Event`) logs after a method threw is
  written outside the wrapper, so it has no `runId`; the run's `error` carries the exception.
- Request-scoped listeners (resolved per emission) and jobs the app adds to the registry by hand
  are not recorded; `events_listeners` already marks the former `requestScoped`.
- The log owners symbol is now `Symbol.for('@jsirp/nestjs-mcp/log-owners')` and holds an array.
- `test/fixtures/app/runs.module.ts` (opt-in `runs: true`, needs both peers): a cron that logs and
  throws (fired with `fireOnTick()`), a timeout and an interval that succeed, listeners that throw
  sync, async and with `suppressErrors: false`, an `async: true` listener, and a controller that
  emits inside a request.

#### Verification

`test/runs.spec.ts` (11 tests): a cron fired through the registry is listed by
`runs_list({ outcome: 'threw' })` with its error and `schedule_jobs` shows its `lastRun` as
`threw`; a timeout and an interval are `ok` with their duration; `run_get` lists the line logged
inside the run and `logs_tail({ runId })` the same seqs, while the scheduler's error line has no
`runId`; an `async: true` listener's run and line; `emit`/`emitAsync` give the same values and
rejections with and without the inspector (sync and async throws, `suppressErrors: false`,
`async: true`, a value returned, no listener), and each throwing listener is `threw`, with
`events_listeners.lastRun`; direct calls are not runs; a `forFeature` instance lists only
`CatsService` runs and answers `not_found` for one outside; a listener run inside a request carries
its `requestId` and its line is in both `run_get` and `request_trace`; with `tools.runs: false` no
tool and no own property; without the peers' modules no tool. `test/without-peers.spec.ts`: no
`run*` tool, `app_info.tools.runs: false`, a method with both peers' metadata left unwrapped.
Red check: with the property definition disabled, 7 of the 11 fail (the other 4 assert absences).
`yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (20 suites / 253
tests) green on Nest 11.2.8 and on Nest 10.4.22 (scratch copy).

### Log entries carry the request they were written in (ticket #27, 2026-10-25)

#### Done

- `LogRecord` gains an optional `requestId`: the id of the request traced when the entry was
  captured (the correlation header's value or the generated id `requests_list` shows). Entries
  written outside a request have none.
- The tee reads the active trace when it copies a call; the log sink does the same when a line
  arrives while it is connected. Both use `current()` of `src/requests/trace-context.ts`, the lookup
  #18 made survive a middleware that loses the async context, so a multipart request through multer
  keeps its log lines as it keeps its steps. A line the sink held before it was connected has none.
- `logs_tail` gains a `requestId` filter.
- `request_trace` gains `logs` (the request's entries the logs buffer still holds, oldest first, at
  most 200, the newest), `logsTruncated: true` beyond 200 and `logsDropped: true` when the buffer
  already discarded some of them. Only with the `logs` group on; with `requests` off no entry
  carries `requestId`.
- One place stamps entries: `src/logs/log-origin.ts` (`currentOrigin`, `pushLog`, `logsOf`).
- README (logs and request traces) and `GLOSSARY.md` (*request id*, *trace*).

#### Hot decisions

- **Entries are matched to the trace object, not only to the id.** Each stamped entry also keeps
  its trace record under a symbol key (`Symbol.for('@jsirp/nestjs-mcp/log-owner')`), which the
  buffer's spread copies and `JSON.stringify` leaves out. `request_trace` lists the entries of that
  very trace, so a client that reuses an id, or two apps of one process that receive the same id,
  never mix lines. `logs_tail({ requestId })` filters by the id string, as the ticket asks, so it
  does list every request that used it.
- **`logsDropped` from the first `seq`:** per buffer and per trace (`WeakMap`s), the `seq` of the
  first entry the trace wrote. The buffer drops the oldest first, so some of the request's lines
  are gone exactly when that `seq` is older than the oldest entry held. No counters on the trace.
- **The newest 200 when truncated**, unlike steps (the first 256): the lines nearest the failure
  are the ones an agent reads a trace for.
- **Lines of a request are listed whatever the instance's scope**: the trace was already checked
  against it; filtering its lines by class name as `logs_tail` does would hide, for instance, the
  line Nest's `ExceptionsHandler` writes for an unhandled error.
- **Held sink lines carry no `requestId`**, as the ticket says, even though the origin could be read
  on arrival: they were not delivered in the context they were written in.

#### Notes for the next session

- For #28: add the run's lookup to `currentOrigin()` in `src/logs/log-origin.ts` (a `runId` next to
  `requestId` in `LogOrigin` and `LogRecord`, the run record as `owner`), a `runId` filter in
  `logsTail`, and `logsOf(buffer, run)` gives `run_get` its lines and `logsDropped` as is.
- A stamped entry holds a reference to its trace record, so a trace evicted from the requests
  buffer stays in memory while any of its lines is in the logs buffer (bounded by
  `logs.bufferSize`).
- Two copies of this package in one process (two Nest majors) each have their own
  `AsyncLocalStorage`: a tee installed by one copy does not see the traces of the other.

#### Verification

New fixture `LoggedModule` (opt-in, `logged: true`): a handler that logs twice across an await and
throws, and one that logs `count` lines `delay` ms apart. `UploadController.form` now logs a line.
`test/request-logs.spec.ts`: the failing request's trace lists its two lines and Nest's
`ExceptionsHandler` line, the handler step `threw`, and `logs_tail({ requestId })` answers the
same seqs and nothing of another request; two concurrent requests whose lines interleave each list
only their own; a generated id; a reused id lists only the latest request's lines; `logsDropped`
with `logs.bufferSize: 4`; 250 lines give the newest 200 and `logsTruncated`; `logs: []` for a quiet
request; with `tools.requests: false` entries have exactly the keys they had; with
`tools.logs: false` traces have no `logs*` field. `test/multipart.spec.ts`: the multer request keeps
its line. `test/log-sink-app.spec.ts`: pino lines written inside a request (`PinoLogger`, Nest's
`Logger` through pino, pino-http's `request completed`) carry its id and `request_trace` lists
them; a line outside a request has none. `test/log-sink.spec.ts`: a connected sink stamps the
traced request; a held line is not stamped. `yarn format-check`, `yarn lint`, `yarn type-check`,
`yarn build`, `yarn test` (19 suites / 242 tests) green on Nest 11.2.8 and on Nest 10.4.22 (scratch copy).

### Traces survive a middleware that loses the async context (ticket #18, 2026-10-25)

#### Done

- A request whose async context a middleware lost after the trace middleware opened it keeps its
  steps, `controller`, `handler`, `route` and `module`. Before, a multipart request through multer
  in a feature module had `steps: []` and no identity.
- The trace middleware also keeps each trace by its request object (a `WeakMap`). When
  `AsyncLocalStorage` has no store, the guard, interceptor and filter wrappers and the handler
  interceptor find the trace through the request of their `ExecutionContext`/`ArgumentsHost`, and
  run the call back inside the trace's context (`withTrace`). Nest binds `next.handle()` to the
  context it is called in, so later interceptors, pipes and the handler find it with `current()`.
- `current(request?)` in `src/requests/trace-context.ts` is the one lookup: the async context
  first, then the trace of the request, when given.
- README: how a lost context is recovered.

#### Hot decisions

- **Cause confirmed, with a nuance:** multer up to 2.2.0 calls `next` from busboy's stream callbacks,
  where `AsyncLocalStorage.getStore()` is `undefined` (a probe store opened in the middleware is gone
  in the callback). multer 2.3.0 and later wrap `next` in an `AsyncResource` themselves, so the
  issue's repro passes with the multer `@nestjs/platform-express` 11.2.8 brings (2.4.0) and fails
  with 2.0.2. With multer in the root module the trace was complete because that middleware ran
  before the trace middleware opened the context, so nothing was lost after it.
- **Binding `next` in the trace middleware does not help:** it calls `next` synchronously, inside
  its context; the context is lost later, inside another middleware's callback, whose `next` the
  inspector does not hold. The fix is the `WeakMap` fallback plus re-entering the context in the
  first enhancer that has the request.
- **Test dependency:** `multer@2.2.0` pinned as a devDependency (with `@types/multer`), the last
  release that loses the context, so the fixture reproduces the bug on Nest 10 and 11 alike. Never
  a runtime dependency.

#### Notes for the next session

- For #27: `current()` without arguments finds the trace in guards, interceptors, pipes, the handler
  and filters, which now run inside the context again. Code that runs between the middleware that
  lost the context and the first guard (other middlewares) still has none; with the request at
  hand, `current(request)` finds it.

#### Verification

New fixture `UploadFeatureModule` → `UploadModule` (opt-in, `upload: true`): multer in a class
middleware declared two levels below the root, a guard, an interceptor, a body pipe and a filter.
`test/multipart.spec.ts`: the multipart trace has the same steps and identity as the JSON one (red
without the fix: `steps: []`), the filter of a multipart request is recorded, and neither fields
nor files reach the trace. The issue's JS repro with multer 2.0.2 gives `guard:OkGuard:allowed`,
`handler:C.form:ok`, `module: CatsModule` in both layouts. `yarn format-check`, `yarn lint`,
`yarn type-check`, `yarn build`, `yarn test` (18 suites / 229 tests) green on Nest 11.2.8 and on
Nest 10.4.22 (scratch copy).

### Unnamed parameter pipes keep their level in traces (ticket #20, 2026-10-25)

#### Done

- A pipe step carries the `param` `route_get` shows for its argument: the name Nest passes in
  `ArgumentMetadata.data` (`'id'`), or `#<index>` for an argument without a name
  (`@Param(Pipe) params`), so `levelOf` matches it and the step has its `level`. Before, the step of
  an unnamed argument had no `param` and no `level`.
- One source for both: `src/routes/route-arguments.ts` reads a handler's route arguments and names
  them (`routeArguments`, `argumentName`) for `route_get`, and finds the argument a pipe call runs
  on (`argumentOf`) for the trace. The trace keeps the controller class and handler key it
  identified (`ActiveTrace.target`, internal) to look them up.
- README: the `pipe` step's `param`.

#### Hot decisions

- **Nest does not pass the argument's index to a pipe**, so the argument is found by the `type` and
  `data` the pipe receives, matched against the paramtype in each route-arguments key (`body` 3,
  `query` 4, `param` 5; `custom` for files, the raw body and custom decorators). Two candidates
  (`@Body() a, @Body() b`) are told apart by whose own pipes include the running pipe; still
  ambiguous, the step has no `param` rather than a guess.
- **Every pipe on an unnamed argument gets its `#n`**, global and `@UsePipes` ones too, as named
  arguments already gave them `'id'`: `param` says which argument the pipe ran on. Their `level`
  is unchanged (they match the chain's entry without `param`).

#### Notes for the next session

- Pre-existing, not changed: a pipe that is both global and a parameter pipe of the same argument
  (`useGlobalPipes(new ValidationPipe())` and `@Body(ValidationPipe)`) gives both steps the same
  `name` and `param`, so both read `level: 'method'`.
- `inlineInstances` in `src/requests/wrap-enhancers.ts` still reads the route-arguments metadata on
  its own; it could use `routeArguments`.

#### Verification

`WrappedModule` gains `GET /wrapped/piped/:id` with `@Param(UpperPipe)`; `test/requests.spec.ts`
checks that `route_get` shows `param: "#0"` and the trace step carries `param: "#0"` and
`level: 'method'` (red without the fix: neither field). `test/route-matching.spec.ts` covers argument
naming, the type and data match and the ambiguous case. `yarn format-check`, `yarn lint`,
`yarn type-check`, `yarn build`, `yarn test` green.

### Wrapped handlers keep their route in traces (ticket #19, 2026-10-25)

#### Done

- The trace names its handler by the property key under which the controller's prototype chain
  holds `context.getHandler()` (`handlerKey`, `src/support/handler-key.ts`), the key Nest registered
  the route by and `routes_list` shows, and falls back to the function's `name` when no key holds
  it. A method decorator that replaced the handler with a wrapper (`descriptor.value = function
  (...args) {…}`) gave `handler: ""` and step `C.`; now the trace finds its route, so it has
  `module`, `level` on every step and `notTraced`, and `requests_list` its `handler` and `module`.
- The lookup reads descriptors (no getter of the app runs) and walks the whole chain, so a wrapped
  handler inherited from a base class is named on every controller that inherits it.
- README: the `handler` step is named by the property key.

#### Hot decisions

- **Cached per controller class, then per function**, not per function alone: a base class's handler
  is one function for every subclass, and the key is looked up on the chain of the class that ran.
- **The same function under several keys** (an alias on the prototype): its own `name` wins if it is
  one of them, otherwise the first key in prototype order.

#### Verification

New fixture `WrappedModule` (opt-in, `wrapped: true`) with a wrapped handler (a controller guard and
a request-scoped interceptor on it) and a wrapped handler two controllers inherit;
`test/requests.spec.ts` checks name, `module`, `level` and `notTraced`, and
`test/route-matching.spec.ts` the key lookup (several keys, inheritance and overrides, getters).
`yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` green.

### Log sink: the host's own logger in `logs_tail` (ticket #24, 2026-10-25)

Implements decision 2 of [ADR-0004](docs/adr/0004-own-listener-and-log-sink.md).

#### Done

- `createLogSink()` (`src/logs/log-sink.ts`) returns a `LogSink`: a `Writable` the host adds to its
  logger's outputs (pino `multistream`, a plain stream) plus `record(entry)` for loggers that hand
  over objects (a winston transport). Passed as `logs.sink`, from `forRoot` or an `*Async` factory.
- Built-in mapping (`src/logs/normalize.ts`): pino and bunyan JSON lines (numeric levels by band,
  `msg`, `time`, `context` or `name`, `err.stack`), winston-style objects (level names, colour codes
  stripped, `message`, `timestamp`, `context`) and plain text (`log`, the line as message). One write
  with several lines gives one entry each. `logs.normalize(record)` maps other formats; `undefined`
  falls back to the built-in mapping.
- `logs.capture: 'nest' | 'sink' | 'both'` (default `'both'`): `'sink'` installs no tee, `'nest'`
  ignores the sink. Every entry carries `source: 'nest' | 'sink'`; `logs_tail` gains a `source`
  filter. Tee and sink feed one buffer, so `seq` orders both.
- `logs_levels` gains `capture` and `sink: { connected, received, errors, lastError? } | null`.
- The sink never throws into the logger and never emits `error`: a throwing `normalize`, an
  unreadable chunk or a failing push is swallowed and counted; with a throwing `normalize` the line is
  still recorded through the built-in mapping. Strings are kept exactly as written.
- New option checks: an unknown `logs.capture`, a `logs.sink` that is not a sink, `capture: 'sink'`
  without a sink, a non-function `normalize`.
- README: options, the `Logs` section, and "Reading your own logger" with the pino (nestjs-pino) and
  winston recipes, what is captured with nestjs-pino with and without a sink, and which `capture` to
  pick. Master plan: the tee is installed at `onModuleInit` (it said `onApplicationBootstrap`).

#### Deviations from ADR-0004

- The sink is itself the writable (`LogSink extends Writable`, with `record` on it), not an object
  holding a stream and a function, so `multistream([stdout, sink])` takes it as it is.

#### Hot decisions

- **The sink holds what arrives before an instance connects it** (up to 1000 entries, oldest dropped)
  and delivers it on connect with the arrival time, so the host can create it before its logger and
  lines from module construction are kept. Lines are parsed on delivery, so an unconnected sink (the
  inspector disabled) costs a bounded queue of strings. On `onModuleDestroy` the sink is
  disconnected and holds again, so an app that restarts in the same process reads it afresh.
- **`write` is overridden**: each chunk is read at once whatever the stream's state, the callback is
  called and `true` returned. No backpressure, and a write after `end` (a piped source that finished)
  is read instead of becoming an `error`.
- **Only the mapped fields are kept**: level, message, context, timestamp, stack. Other fields of a
  record (`req`, `res`, pino bindings) are not stored, in line with "headers per option, never bodies"
  for traces; the README says so.
- **`timestamp` is the record's own time** (`time` or `timestamp`) when it parses, otherwise when the
  sink received it. `stack` is kept at any level for the sink (the tee keeps it for `error`).
- **Level names**: `info`, `http` and `notice` are `log`; `trace` and `silly` are `verbose`;
  `crit`/`critical`/`alert`/`emerg` are `fatal`; anything unknown is `log`.
- **`logs` is per process, like the tee**: the first instance decides `bufferSize`, a sink already
  connected keeps its buffer (and its `normalize`) for the other instances of the app, and an
  instance with `capture` other than `'sink'` installs the tee. The README asks for the same `logs`
  on every instance.
- `pino` stays a devDependency (`^9.6`, the one `nestjs-pino` 4 brings); winston is not added: the
  winston criterion is covered by a transport-shaped object calling `record`, which is all a winston
  transport does.

#### Effect on other tickets (not closed here)

- **#22**, point 1 (`PinoLogger` is not captured): resolved. With a sink on pino's `multistream`,
  `PinoLogger`/`@InjectPinoLogger()` lines and the `pino-http` request lines are in `logs_tail`
  (`source: 'sink'`); without one, the README's table says they are not. Point 2 was resolved by
  #23, so #22 is resolved in full.

#### Verification

`yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (16 suites, 216
tests) green on Nest 11 / Node 20; the same suite green on Nest 10.4.22 (the CI's Nest 10 step,
run in a scratch copy).

### Own listener instead of a Nest controller (ticket #23, 2026-10-25)

Implements decision 1 of [ADR-0004](docs/adr/0004-own-listener-and-log-sink.md).

#### Done

- The inspector answers on its own `node:http` server (`src/transport/listener.ts`), `127.0.0.1:7777`
  by default, opened by the first instance at `onApplicationBootstrap` and closed at `onModuleDestroy`
  of the last one (`closeAllConnections`, so `app.close()` frees the port at once). `forRoot` answers
  at `/`, each `forFeature` at its `path`. Every instance joins the listener at `onModuleInit`, so it
  knows all of them before it opens.
- New options `listen: { host?, port? }` (`port: 0` picks a free one) and `authorize(req)` over the raw
  `IncomingMessage`, per instance; `false` or a throw (logged) answers 403. Unknown path → 404, `GET`
  and anything but `POST` → 405 with `Allow: POST`, all JSON-RPC errors.
- Startup: `Inspector listening at <url>` per instance; a port in use fails with an error naming
  `listen.port`; one `warn` per instance listening beyond loopback without `authorize`; two instances
  on one path, or with different `listen`, fail at startup.
- `app_info` gains `mcpUrl`; `mcpPath` is now the path on the listener (`/`, `/cats`), with no global
  prefix.
- The trace recorder no longer excludes the inspector's route: its calls never reach Nest.
- Test harness: each app gets a free inspector port (`freePort()`), `connect(path)` and `inspect(path)`
  talk to the listener, `fetch` to the app.

#### Breaking

- `guards` and `localOnly` are gone, with `LocalOnlyGuard`, `EnabledGuard` and the controller. No
  route of the inspector exists in the app any more: the old `/_mcp` (or `/<prefix>/_mcp`) answers the
  app's own 404, and `routes_list` no longer lists it.
- `path` defaults to `/` (was `_mcp`) and is relative to the listener, not to the global prefix; `'/'`
  is now accepted.
- In the `*Async` variants only `path` (and, optionally, `enabled`) is static; `listen` and `authorize`
  may come from the factory. A factory that returns `enabled: false` opens no listener, instead of
  answering 404 on a mounted route.

#### Deviations from ADR-0004

- **One listener per app, not per process.** Instances are grouped by the app's `ModulesContainer`.
  With one Nest app per process (the normal case) this is the ADR's "one per process"; two apps in one
  process each get their own listener and need different ports (the second fails naming
  `listen.port`). Grouping per process would have made two apps share routes, and the first app's
  `close()` would have closed the second's endpoint.

#### Hot decisions

- `listen` is shared: an instance that does not set it takes the one another instance set, or the
  default; two different explicit ones are an error rather than a silent first-wins, because module
  order decides which instance bootstraps first (`forFeature` instances usually do).
- `authorize` is per instance, like the old `guards`, so a module instance can be guarded differently.
- The path is taken from the raw request target with the query string dropped, not through `new URL`,
  so `//x` is never read as a host.
- A wildcard bind is logged as `http://localhost:<port>`, as the old controller URL was.

#### Effect on other tickets (not closed here)

- **#13** (swagger 7 on Nest 10 crashes in `createDocument`): resolved by removing the controller.
  A throwaway Nest 10.4.22 + `@nestjs/swagger` 7.4.2 app calling `SwaggerModule.createDocument` before
  `listen`: the previous build fails with `TypeError: Cannot read properties of undefined (reading
  '0')`; this one generates the document, whose paths are only the app's (`/cats`).
- **#22**, point 2 (the host's global enhancers run on the endpoint): resolved; a counting global
  guard stays at zero while the inspector is queried. Point 1 (`PinoLogger`) belongs to #24.

#### Verification

`yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test` (14 suites, 164
tests) green on Nest 11.2.8 / Node 20; an SDK round-trip on Nest 10.4.22 against the packed build
lists the tools and frees the port on `close()`.

---

<!-- PHASE ENTRIES START HERE -->

## Phase 6b — CI matrix and release workflow (2026-10-25)

**Work commit:** `713510f` (ticket #10).

### Done

- `.github/workflows/ci.yml` on push to `main`, pull requests and `workflow_call`: Nest `[10, 11]` ×
  Node `[20, 22]`, `fail-fast: false`. Corepack yarn 4, yarn cache per cell, `yarn install
  --immutable`, the Nest 10 cell `yarn add -D` of `@nestjs/{common,core,platform-express,testing}@^10`
  at once, a step that prints `@nestjs/core`'s version and fails if its major is not the cell's, then
  `format-check`, `lint`, `type-check`, `build`, `test`.
- `.github/workflows/release.yml` on `v*.*.*` tags and `workflow_dispatch`: the CI workflow as
  `needs`, then build, a tag = `v<package.json version>` check, release notes from the `## x.y.z`
  section of `CHANGELOG.md` (required for a real publish), `npm publish --provenance --access public`
  with `NPM_TOKEN`, and `gh release create` with those notes. A manual run with `dry-run` (the
  default) or a tag ending in `-test` runs every step with `npm publish --dry-run`, skips the tag
  check and creates no release.
- README "Contributing": standalone setup, the suite on Nest 10 locally, CI, branch protection and
  how a release is cut.

### Deviations from the plan

- `release.yml` was validated by a manual `workflow_dispatch` dry run, not a `v0.0.0-test` tag:
  sessions create no tags. The `-test` tag path exists and takes the same dry-run branch.
- The yarn cache is `actions/cache` over `yarn config get cacheFolder`, not `setup-node`'s
  `cache: yarn`: that one needs yarn on the PATH before corepack is enabled for the matrix Node.
- `yarn.lock` and the `package.json` fields `repository`, `bugs`, `homepage` were already in place
  from phase 1: nothing to create there.
- No code of earlier phases needed changes: the Nest 10 cells were green on their first run.

### Hot decisions

- `ci.yml` is also a reusable workflow (`workflow_call`), so the release runs exactly the same
  matrix; its `push` trigger is limited to `main`, so a tag push runs CI once, inside the release.
- The Nest 10 step sets `YARN_ENABLE_IMMUTABLE_INSTALLS=false`: yarn makes every install immutable
  on CI, and `yarn add` changes the lock (in that job's workspace only).

### Stumbles and resolutions

- Yarn 4 does not run `pre*` scripts: `yarn test` never runs `pretest` (`yarn build`). In a clean
  checkout every suite fails with "Could not locate module @jsirp/nestjs-mcp mapped as
  dist/index.cjs". CI and the README build first; `pretest` is left as is (it still works for
  `npm test`).
- Pushing `.github/workflows/` needed no `workflow` scope: git pushes over SSH.

### Critical information for later phases

- **Phase 7**: `gh secret list` is empty: `NPM_TOKEN` must be added before the first tag, and
  branch protection on `main` (the four `ci (Nest N, Node M)` checks) is still to be set. The first
  real release needs a `## 0.1.0` section above the logbook, or the workflow fails before publishing.
- Nest 10 was verified on 10.4.22 (the `'*'` middleware path, `addGlobalInterceptor`, the graph
  metadata, `Logger.staticInstanceRef`, event-emitter 3 and schedule 6): the full suite passes there.
- GitHub warns that `actions/checkout@v4`, `setup-node@v4` and `cache@v4` target Node 20 and are
  forced onto Node 24; bumping the action majors is a cleanup.

### Verification

- `yarn test` at start: 15 suites, 164 tests green (Nest 11.2.8, Node 20).
- Local Nest 10 run in a scratch copy (`yarn add -D` of the four packages, `@nestjs/core` 10.4.22):
  `format-check`, `lint`, `type-check` exit 0; `yarn build && yarn jest`: 15 suites, 164 tests green.
- CI on `713510f`: <https://github.com/jsirp-dev/nestjs-mcp/actions/runs/40159758920>, four cells
  green; the version step prints `@nestjs/core 10.4.22` in both Nest 10 cells and `11.2.8` in the
  Nest 11 ones; each cell: 15 suites, 164 tests.
- Release dry run: <https://github.com/jsirp-dev/nestjs-mcp/actions/runs/40159850065>, the four CI
  cells then `publish` green; `npm publish --provenance --access public --dry-run` printed
  `+ @jsirp/nestjs-mcp@0.0.0 (dry-run)`; tag check and GitHub release skipped. Afterwards
  `npm view @jsirp/nestjs-mcp` is a 404, `git tag -l` and `gh release list` are empty.
- `yarn install --immutable` standalone: exit 0. `npm pack --dry-run`: 10 files, 218.0 kB.

## Phase 6 — Events, listeners and scheduled jobs (2026-10-25)

**Work commits:** `c72c28d` (ticket #8, events), `9449ed5` (ticket #9, schedule).

### Done

- Optional peers by guarded `require` (`src/support/optional-peer.ts`, `tryRequire`) and the
  container walk `src/support/for-each-instance.ts` (`forEachInstance`, aliases skipped, wrappers
  without instance included). `app_info.tools.events` and `.schedule` are real.
- Events (#8): `events_listeners({ event?, scope? })`, every `@OnEvent` listener of providers and
  controllers (request-scoped ones flagged `requestScoped`), read from metadata through descriptors;
  `events_recent({ limit?, event? })`, `emit`/`emitAsync` wrapped once on the app's `EventEmitter2`
  (`Symbol.for('nestjs-mcp.emit-recorder')`, shared by every instance), `{ seq, event, method,
  timestamp, listeners }`, never the payload, `emissions: 'app-wide'`.
- Schedule (#9): `schedule_jobs({ kind?, scope? })` reads `SchedulerRegistry` per call: cron jobs
  (`expression`, `timeZone` when not the process's, `running`, `lastRun`, `nextRun` while running),
  intervals (`everyMs`) and timeouts (`delayMs`, `running: false` once fired or cleared), the ones
  the app added by hand included. `@Cron`/`@Interval`/`@Timeout` metadata gives class, method and
  module.
- Fixture: opt-in `events` and `schedule` (`AppModule.with`); `CatsService` has `onCatAdopted`,
  `onAnyCatEvent` (`cat.*`), the cron `cleanup` (`0 3 * * *`), an unnamed cron `weeklyReport` and the
  interval `refresh`; `HealthController` has `onAppReady` and the timeout `warmup`.
  `test/events.spec.ts` (18), `test/schedule.spec.ts` (12), `test/without-peers.spec.ts` (1, both
  peers). "Events" and "Scheduled jobs" sections and limitations in the README.

### Deviations from the plan

- `EVENT_LISTENER_METADATA` is not exported from the package entry in event-emitter v3 (only from
  `dist/constants`): it is the literal string, the same in v1-v3. The schedule metadata keys are
  literals too, the same strings in schedule 4 and 6 (checked against both tarballs): no import of
  either peer in `src/`.
- The emitter and the registry are found by walking providers: token === the peer's class, else a
  class token with the same name (another copy of the package). Extra files
  `src/events/install-events.ts` and `src/schedule/install-schedule.ts` (find + install).
- The events buffer is a constant of 500 (`DEFAULT_EVENTS_BUFFER_SIZE`), not an option: the overview
  promises none.
- The job model adds `module`, `timeZone` and `delayMs`: a timeout's delay is not a period
  (`everyMs` stays for intervals only).
- Not `MetadataScanner`: both readers walk prototypes through descriptors (no getter of the app
  runs), now shared in `src/support/class-methods.ts`; the module naming of both tool groups moved
  to `src/tools/module-name.ts`.

### Hot decisions

- Both groups are installed in `NestMcpModule.configure` (before every `onModuleInit` of the app),
  so emissions from the app's own hooks are recorded; the tools register in
  `NestMcpToolsSetup.onModuleInit` only if `context.events` / `context.schedule` was set.
- Wildcards and the `event` filters resolve through a probe emitter of the app's own class with the
  same `wildcard`/`delimiter`; equality if it cannot be built. `listeners` = `listenerCount(event)`
  at emission time, before the listeners run.
- A decorated job is matched to the registry by name; an unnamed one (the registry knows it by a
  generated id) by expression or period, only when exactly one job on each side has it.
- Scope: jobs declared by classes in scope. A job the app added to the registry by hand has no class
  and no module, so only an app-wide answer (`forRoot`, or `scope: 'app'`) lists it.
- Interval and timeout periods and pending state come from Node's `Timeout` (`_idleTimeout`,
  `_destroyed`), duck-typed; the decorator's value fills the period when the timer has none.
- `running` is cron 4's `isActive`, else cron 3's `running`; `nextRun` is `nextDate().toISO()`, else
  `toString()`, and is left out for a stopped job. Every read of a job is guarded: an odd job
  answers with what could be read.

### Stumbles and resolutions

- `npx prettier` resolves another Prettier than the repo's (`yarn prettier`), and they disagree on
  some files: format with the repo's.
- Decorated jobs in the fixture schedule real timers; `ScheduleModule` clears them all on
  `app.close()` (dynamic ones included), so jest exits cleanly.

### Critical information for later phases

- **Phase 6b**: devDependencies `@nestjs/event-emitter@^3.0.0` and `@nestjs/schedule@^6.0.0`, both
  with peers Nest `^10 || ^11`; the Nest 10 leg is their first run there. Schedule 4 (cron 3) is
  covered only by a unit test of the reader with a cron-3-shaped job.
- **Phase 7**: listeners added by hand with `emitter.on(...)` count in `listeners` but are not
  listed; decorated jobs `ScheduleModule` did not register (request-scoped providers, a kind switched
  off in `forRoot`) are not listed.
- `wrap-enhancers.ts` keeps its own container loop (moving it onto `forEachInstance` is a cleanup).

### Verification

- `yarn test` at start of #9: 14 suites, 152 tests green.
- `yarn build && yarn test`: 15 suites, 164 tests green. `schedule.spec.ts` covers `cleanup` with
  its expression and an ISO `nextRun` at 03:00, the unnamed cron matched by expression, decorated and
  registry-added intervals, timeouts and cron jobs with their period, a stopped cron and a fired
  timeout, `kind`, module scope and `scope: 'app'`, `app_info`, an app without `ScheduleModule` and
  `tools.schedule: false`; two unit tests read cron-3-shaped jobs and metadata without
  `SCHEDULER_NAME`.
- `without-peers.spec.ts` green; a control run without the `@nestjs/schedule` mock fails listing
  `schedule_jobs`, so the guarded require is what keeps the group out.
- `yarn lint`, `yarn type-check`, `yarn format-check`, `yarn build` and the pre-commit hook: exit 0.

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
