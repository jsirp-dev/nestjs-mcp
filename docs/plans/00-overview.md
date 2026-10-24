# `@jsirp/nestjs-mcp` — Master plan

Date: 2026-10-25
Method: the `phased-project-development` skill. This is the master plan; each phase has its own
`phase-NN-*.md` in this folder ([index](README.md)). The per-phase logbook is the package
[`CHANGELOG.md`](../../CHANGELOG.md) and the entry point for any session is the package
[`CLAUDE.md`](../../CLAUDE.md). The plan lives inside the package so it travels with it. The
vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md) and the decisions that were real trade-offs in
[`docs/adr/`](../adr/).

## Context

A coding agent working on a running NestJS app sees the source and the HTTP surface, but not what Nest
actually built: which module imports which, where each provider is injected, which guards,
interceptors and pipes a given request goes through, who listens to each event, which cron jobs are
alive and what the logger is writing right now. Next has `next-devtools-mcp` for this (it plugs into
the dev server and reports errors, routes and logs). The closest thing for Nest is `nestjs-devtools-mcp`
(npm, MIT, 2026), a stdio bridge with a preload hook that gives routes, logs, errors, request history
and config. It does **not** give the module and provider graph, the enhancers per route, the trace of
a request through them, or events and scheduled jobs. That is the gap.

It is built as a **publishable, framework-agnostic package** (`@jsirp/nestjs-mcp`, MIT) in **its own
repository** (`github.com/jsirp-dev/nestjs-mcp`). During development it may be embedded as a **git
submodule** in a host monorepo that runs real Nest apps on both supported majors, so the package is
exercised against them before it is published; it stays self-sufficient outside that host. Nothing from
any host enters the package: no imports, no domain vocabulary, no names, no assumptions about its
logger, RPC layer or database. Validation against a real host is the last step before the first
release, and that host is one consumer among others.

## What it is, and is not

An **inspector**: it exposes the running app to an agent so the agent can understand and debug it. It
never exposes business logic as MCP tools; that is what `nestjs-mcp` and `@rekog/mcp-nest` do, and
mixing the two dilutes the name and puts business endpoints behind a switch meant to be off in
production ([ADR-0003](../adr/0003-inspector-only-never-business-tools.md)). Only MCP *tools* in v1,
answering with JSON as text; no resources or prompts; the tool registry is internal.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript 5, ESM + CJS via `tsup` (`dts: true`) | Nest consumers are still CJS; tsup emits both |
| Framework | NestJS module; peer `@nestjs/common` and `@nestjs/core` `>=10 <12` | Both majors are in active use; the inspector API exists in both |
| Configuration | Nest's `ConfigurableModuleBuilder`: `forRoot`, `forRootAsync`, `forFeature`, `forFeatureAsync` | The official mechanism; works with `ConfigService` or any other source without depending on `@nestjs/config` |
| Protocol | `@modelcontextprotocol/sdk` ^1.32, **Streamable HTTP** transport embedded in the app | No separate process: the client points at a URL of the app ([ADR-0001](../adr/0001-embedded-streamable-http-endpoint.md)) |
| Validation | `zod` (peer, the range the SDK accepts) for tool inputs | What the SDK expects in `registerTool` |
| Optional peers | `@nestjs/event-emitter`, `@nestjs/schedule` | Only if the app has them; detected at runtime |
| Tests | jest + ts-jest, a fixture Nest app under `test/fixtures`, the real MCP client from the SDK | End-to-end over the protocol |
| CI | GitHub Actions: matrix Nest 10 and 11 × Node 20 and 22; release on tag with npm provenance | A peer range is a promise only a matrix proves |
| Node | `>=20` | Current LTS line; pinned in `.nvmrc` |

## Public API the plan promises

```ts
import { NestMcpModule } from '@jsirp/nestjs-mcp';

// Whole app: everything Nest built.
@Module({ imports: [NestMcpModule.forRoot({ /* NestMcpOptions */ })] })
export class AppModule {}

// One module: what that module and its imports see, on its own endpoint.
@Module({ imports: [NestMcpModule.forFeature({ path: '_mcp/cats' })] })
export class CatsModule {}

// Any source of configuration, through Nest's configurable-module pattern.
NestMcpModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ enabled: config.get('INSPECTOR_ENABLED') === 'true' }),
});
```

`forRoot` is optional; any number of `forFeature` instances may coexist, each with its own path, guards
and switches. Each instance gets its own controller subclass, so instances never share metadata.

`NestMcpOptions` (all optional unless noted; defaults make it work with no configuration):

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `enabled` | `boolean` | `process.env.NODE_ENV !== 'production'` | **The** switch. Off, the module registers nothing: no controller, no log tee, no tracing. A default, not a rule: set `true` where you want it and protect it with `guards` |
| `path` | `string` | `'_mcp'` for `forRoot`; **required** for `forFeature` | Endpoint route, relative to the global prefix, version-neutral. With prefix `api`: `/api/_mcp` |
| `guards` | `Type<CanActivate>[]` | `[]` | Nest guards on the endpoint, like `@UseGuards` |
| `localOnly` | `boolean` | `true` | Reject anything not from loopback. `localOnly: false` without `guards` logs a `warn` and starts anyway |
| `tools` | `{ graph?, routes?, logs?, requests?, events?, schedule? }` booleans | all `true` | One switch per tool group. Off removes its tools and, for `logs` and `requests`, installs nothing intrusive |
| `logs` | `{ bufferSize?: number }` | `{ bufferSize: 2000 }` | Ring buffer for the Logger tee. Transparent: nothing masked or altered |
| `requests` | `{ bufferSize?: number; idHeader?: string; headers?: 'none' \| 'names' \| 'full' }` | `{ bufferSize: 500, idHeader: 'x-nest-mcp-request-id', headers: 'names' }` | Per-request traces. The id header is read, never echoed back. Full URL is stored; request headers per `headers`; bodies never |
| `serverInfo` | `{ name?: string; version?: string }` | the host app's `package.json` | What the server reports in `initialize` |

Warnings at bootstrap, once each, through Nest's `Logger` (context `NestMcp`): the endpoint URL; missing
`snapshot: true` (with the exact option to set); endpoint open to the network without guards.

MCP tools (`snake_case`, grouped by prefix; every tool answers JSON as one text block):

| Group | Tools | Phase |
|-------|-------|-------|
| `app` | `app_info` | 1 |
| `graph` | `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles` | 2 |
| `routes` | `routes_list`, `route_get` | 3 |
| `logs` | `logs_tail`, `logs_levels` | 4 |
| `requests` | `requests_list`, `request_trace` | 5 |
| `events` / `schedule` | `events_listeners`, `events_recent`, `schedule_jobs` | 6 |

## Scope: app or module

An instance has a **scope**: the whole app (`forRoot`) or the closure of the module that imported it
(`forFeature`: that module and everything it imports, transitively). Every tool answers within the
scope: the graph is the sub-graph, routes are those whose controller is in scope, listeners and jobs are
those declared in scope, and traces are those whose handler is in scope. Logs are process-wide, so a
module scope filters them by the class names in scope used as log context (approximate; documented).
The scope is resolved at bootstrap from the serialized graph (which module imports this instance), so
it needs `snapshot: true` like the graph itself; without it, a `forFeature` instance reports
`scope_unresolved` and falls back to app scope for logs.

## Structure

```
packages/nestjs-mcp/
├── package.json              @jsirp/nestjs-mcp, MIT, publishConfig.access=public, Nest peers >=10 <12
├── tsup.config.ts · tsconfig.json · jest.config.cjs · .eslintrc.cjs · .prettierrc.cjs · .nvmrc
├── .husky/pre-commit         Check-only: format-check, lint, type-check, build
├── .github/workflows/        ci.yml (matrix) and release.yml (publish on tag)
├── README.md                 For npm: install, options, tools, limitations
├── CLAUDE.md                 Entry point for any session: reading order and "what NOT to do"
├── CHANGELOG.md              Per-phase logbook (two commits per closure) + release notes
├── GLOSSARY.md               The package's vocabulary
├── docs/
│   ├── plans/                This plan: 00-overview.md, phase-NN-*.md, README.md (not published)
│   ├── adr/                  Decisions that were real trade-offs
│   └── agents/               What the engineering skills read: issue tracker, triage labels, domain docs
├── src/
│   ├── index.ts              Exports NestMcpModule, the options types, the result types
│   ├── nest-mcp.module.ts    ConfigurableModuleBuilder: forRoot/forRootAsync/forFeature/forFeatureAsync
│   ├── nest-mcp.options.ts   Types, defaults, validation
│   ├── instance/             One inspector instance: controller subclass, scope, tool context
│   ├── transport/            Streamable HTTP handling, LocalOnlyGuard, McpServer factory
│   ├── tools/                One file per group: app, graph, routes, logs, requests, events, schedule
│   ├── graph/                SerializedGraph reader and the package's own model (nodes, edges, enhancers, scope)
│   ├── logs/                 Logger tee and ring buffer (installed once per process)
│   ├── requests/             AsyncLocalStorage, middleware, enhancer wrapping, trace buffer
│   └── support/              Ring buffer, optional-peer detection, utilities
└── test/
    ├── fixtures/app/         Minimal invented Nest app: two modules, guard, interceptor, pipe, filter,
    │                         event listener, cron job
    └── *.spec.ts             One spec per group, driving the app through the SDK client
```

Anything host-specific (how a given monorepo embeds the submodule, wires the module into its apps,
documents it or lists the endpoints in its MCP client configuration) lives in that host's own
repository, never here.

## Architecture

```
Claude Code ──HTTP (Streamable HTTP, stateless)──▶ POST /api/_mcp       (controller subclass of the instance)
                                                      │  LocalOnlyGuard + the instance's guards
                                                      ▼
                                                 McpServer (SDK) ── tools, filtered by the instance's scope
                                                                             │
   SerializedGraph (@nestjs/core/inspector, snapshot:true) ◀── graph, routes, scope resolution
   ApplicationConfig (global enhancers) ◀────────────────── routes
   Nest Logger (tee installed once per process) ◀────────── logs
   AsyncLocalStorage + wrapped enhancers + middleware ◀──── requests (installed once per process)
   EventEmitter2 / SchedulerRegistry (optional peers) ◀──── events, schedule
```

Stateless MCP: each `POST` creates a transport and a server, answers and closes. `GET` and `DELETE`
return 405. Process-wide installers (log tee, enhancer wrapping, middleware) are installed once, by the
first instance that needs them; every instance reads the shared buffers through its scope.

## Closed decisions

1. **Runtime, not static.** The source of truth is what Nest built: `SerializedGraph`,
   `ApplicationConfig`, container instances. No source analysis.
2. **Embedded HTTP transport, no separate process.** The client points at the app's URL. No stdio
   bridge in v1 ([ADR-0001](../adr/0001-embedded-streamable-http-endpoint.md)).
3. **The endpoint is a Nest controller**, under the global prefix and `VERSION_NEUTRAL`, so configured
   `guards` are ordinary Nest guards with an `ExecutionContext`. One controller subclass per instance.
4. **Explicit `enabled`**, defaulting to `NODE_ENV !== 'production'`. Nothing is forced off by an
   absolute rule (owner's decision, 2026-10-24). `localOnly: true` by default; `guards` for the rest;
   open to the network without guards warns and starts.
5. **Inspector only.** Never business tools; tools only, text JSON answers; internal registry
   ([ADR-0003](../adr/0003-inspector-only-never-business-tools.md)).
6. **Configuration through `ConfigurableModuleBuilder`** with `forRoot`, `forRootAsync`, `forFeature`,
   `forFeatureAsync`. `@nestjs/config` is documented as an example, never required.
7. **Scope = app or module closure**, resolved at bootstrap from the graph.
8. **The graph requires `snapshot: true`.** The module cannot enable it; it warns once at bootstrap and
   every graph or routes tool returns `snapshot_disabled` with the option to set.
9. **Logs are transparent**: the `LoggerService` the app set with `app.useLogger` (or the default
   `ConsoleLogger`) is wrapped with `Logger.overrideLogger` at `onApplicationBootstrap`, forwarded
   untouched and copied to a ring buffer. Nothing is masked. What a logger writes outside Nest's
   `Logger` (raw `pino-http`, for example) is not captured, and the README says so.
10. **Traces by wrapping instances**: at bootstrap the module wraps `canActivate`, `intercept`,
    `transform` and `catch` on the enhancer instances found in the container (global and per route)
    to record, in an `AsyncLocalStorage` per request, what ran, in which order and how long it took.
    `REQUEST` and `TRANSIENT` providers have no instance to wrap and are reported as not traced
    ([ADR-0002](../adr/0002-request-tracing-by-wrapping-enhancers.md)).
11. **Traces store the full URL**; request headers per the `requests.headers` option; bodies never.
    The correlation header is read from the request and never echoed back.
12. **Optional peers detected at runtime**: `@nestjs/event-emitter` and `@nestjs/schedule` are loaded
    with a guarded `require`; without them their tools are not registered. `events_recent` wraps
    `emit`/`emitAsync` to record emissions without payloads.
13. **Agnostic by construction**: `import/no-extraneous-dependencies` keeps every import inside
    `package.json`; the fixture app is invented and imports nothing from any host.
14. **Express verified; Fastify not supported in v1**, stated in the README with an issue to track it.
15. **Name `@jsirp/nestjs-mcp`**, MIT. `nestjs-mcp` and `nestjs-devtools-mcp` are taken.
16. **Own repository, embeddable as a submodule** (owner's decision, 2026-10-24): the package depends
    on nothing in a host workspace, not even its shared lint or formatter configuration.
17. **Everything in English** from the first commit: code, docs, plan, logbook, glossary, ADRs
    (owner's decision, 2026-10-25).
18. **Commits in English**, two per phase closure, launched by a person. Package commits happen in
    this repo (branch `main`); a host embedding it as a submodule commits only its pointer, on its side.
19. **Issues live in GitHub Issues** of `jsirp-dev/nestjs-mcp`, with the five default triage labels
    ([docs/agents](../agents/issue-tracker.md)).
20. **Release from GitHub Actions on tag**: `npm version` creates the tag, `release.yml` tests, builds and
    publishes with provenance using an `NPM_TOKEN` secret; then the package is listed in the official
    MCP Registry.

## Phases

| # | Document | Delivers |
|---|----------|----------|
| 1 | [`phase-01-bootstrap`](phase-01-bootstrap.md) | Package, `forRoot`/`forRootAsync`/`forFeature`/`forFeatureAsync`, one controller subclass per instance, Streamable HTTP endpoint, `LocalOnlyGuard`, `guards`, bootstrap warnings, `app_info`, fixture app and the first protocol test; CHANGELOG and README |
| 2 | [`phase-02-graph`](phase-02-graph.md) | `graph_*` over `SerializedGraph`: modules, providers, dependencies and dependents, cycles; **scope resolution** for `forFeature` |
| 3 | [`phase-03-routes-and-enhancers`](phase-03-routes-and-enhancers.md) | `routes_list`, `route_get`: each route with its guards, interceptors, pipes and filters in real order (global → controller → method), within scope |
| 4 | [`phase-04-logs`](phase-04-logs.md) | Logger tee installed once per process, ring buffer, `logs_tail`, `logs_levels`, scope filter by context |
| 5 | [`phase-05-request-traces`](phase-05-request-traces.md) | Middleware + enhancer wrapping + `AsyncLocalStorage`; `requests_list`, `request_trace`; correlation header; `headers` option |
| 6 | [`phase-06-events-and-schedule`](phase-06-events-and-schedule.md) | `events_listeners`, `events_recent`, `schedule_jobs` with optional peers, within scope |
| 6b | [`phase-06b-ci-and-release`](phase-06b-ci-and-release.md) | `ci.yml` with the Nest 10/11 × Node 20/22 matrix, `release.yml` publishing on tag with provenance, branch protection notes |
| 7 | [`phase-07-host-validation-and-publish`](phase-07-host-validation-and-publish.md) | Dogfooding against a real host app on both Nest majors, findings filed as issues, README, first tag and MCP Registry listing |

Each phase fits one session (net diff under ~1000 lines). Phases 4 and 5 do not depend on 2 and 3, but
they run in order: each session starts from what the previous one committed.

## End-to-end verification

- `yarn test` in the package: each spec boots the fixture app on a free port and talks to it with the
  SDK `Client` over `StreamableHTTPClientTransport`. CI runs it on Nest 10 and 11.
- Mounted in a real host app with `snapshot: true`: `claude mcp list` shows the instance connected;
  `routes_list` lists the app's routes with their guards; `request_trace` of a real request shows its
  auth guard → interceptors → handler; the same on a Nest 10 host and a Nest 11 host.
- `npm pack --dry-run` lists only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`.

## Non-blocking open decisions

1. **Reusing an existing correlation header** (`x-request-id` from request loggers and proxies): the agent sets
   `x-nest-mcp-request-id` itself today; whether to also accept the app's own id as an alias.
   *Closes in phase 5.* Owner: Jorge.
2. **Fastify**: unsupported in v1 by decision; whether v1.x adds it depends on a real consumer asking.
   *Closes when an issue appears.* Owner: Jorge.
3. **Resources and prompts**: tools only in v1; the graph and the route list are natural resources.
   *Closes after the first public release.* Owner: Jorge.
