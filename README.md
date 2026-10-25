# @jsirp/nestjs-mcp

Runtime [MCP](https://modelcontextprotocol.io) inspector embedded in your NestJS app, for coding agents.

Add one module and your running app exposes an MCP endpoint that tells an agent (Claude Code, Cursor,
any MCP client) what Nest actually built: the module and provider graph, every route with the guards,
interceptors, pipes and filters it goes through, what the app's `Logger` is writing right now, which
enhancers a given request passed through and how long each took, event listeners and scheduled jobs.
Nothing to install on the agent side: it points at a URL of your app.

> Status: **0.1.0 in development**. Today the endpoint and `app_info` work; the other tool groups land
> one by one (see [Tools](#tools)).

## Install

```bash
npm install --save-dev @jsirp/nestjs-mcp
```

Everything a Nest app already has is a peer dependency: `@nestjs/common` and `@nestjs/core` 10 or 11,
`reflect-metadata`, `rxjs`, and `zod` (3.25+ or 4, the versions the MCP SDK accepts).
`@nestjs/event-emitter` and `@nestjs/schedule` are optional peers: their tools appear only if your app
uses them. The only runtime dependency is `@modelcontextprotocol/sdk`.

## Quick start

```ts
import { Module } from '@nestjs/common';
import { NestMcpModule } from '@jsirp/nestjs-mcp';

@Module({
  imports: [NestMcpModule.forRoot()],
})
export class AppModule {}
```

Create the app with `snapshot: true` so Nest keeps the graph the `graph_*` and `routes_*` tools read:

```ts
const app = await NestFactory.create(AppModule, { snapshot: true });
```

At startup the module logs the endpoint, with context `NestMcp`:

```
[NestMcp] Inspector endpoint at http://localhost:3000/api/_mcp
```

### One module on its own endpoint

`forFeature` mounts an instance whose scope is the module that imports it and everything that module
imports. `path` is required. Any number of instances may coexist, each with its own path, guards and
switches.

The scope is resolved from the serialized graph at the first tool call, so it needs `snapshot: true`
too: `app_info.scope` then reads `{ "kind": "module", "module": "CatsModule" }`. Without `snapshot`, it
reads `{ "kind": "module", "module": null, "error": "scope_unresolved", "fallback": "app" }`. The
closure leaves out Nest's internal modules and the instance's own module.

```ts
@Module({
  imports: [NestMcpModule.forFeature({ path: '_mcp/cats' })],
})
export class CatsModule {}
```

### Options from a configuration source

`forRootAsync` and `forFeatureAsync` follow Nest's configurable-module pattern, so any source works.
With `@nestjs/config`, as an example:

```ts
NestMcpModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    enabled: config.get('INSPECTOR_ENABLED') === 'true',
  }),
});
```

Nest reads the endpoint's route and guards before any factory runs, so **`path`, `guards` and
`localOnly` are given statically**, next to `useFactory`, not returned by it. `enabled` may go either
way: given statically and `false`, nothing is registered; returned by the factory as `false`, the
endpoint answers 404, exactly as if it were not mounted, and nothing else is installed.

## Point your agent at it

Claude Code:

```bash
claude mcp add --transport http my-nest-app http://localhost:3000/api/_mcp
```

Or any client that reads an `mcpServers` file:

```json
{
  "mcpServers": {
    "my-nest-app": { "type": "http", "url": "http://localhost:3000/api/_mcp" }
  }
}
```

## Options

All optional, except `path` in `forFeature`.

| Option | Default | What it does |
|--------|---------|--------------|
| `enabled` | `process.env.NODE_ENV !== 'production'` | The switch. When `false` the instance registers nothing. It is a default, not a rule: set it to `true` wherever you want the endpoint and protect it with `guards`. |
| `path` | `'_mcp'` for `forRoot`; required for `forFeature` | Route of the endpoint, relative to the app's global prefix and version-neutral under any versioning. With prefix `api`: `/api/_mcp`. |
| `guards` | `[]` | Nest guards on the endpoint, exactly like `@UseGuards`, after `LocalOnlyGuard`. |
| `localOnly` | `true` | Reject requests that do not come from loopback (`127.0.0.1`, `::1`). |
| `tools` | all `true` | One switch per tool group: `{ graph, routes, logs, requests, events, schedule }`. A group switched off registers no tools and installs nothing. |
| `logs.bufferSize` | `2000` | Size of the ring buffer the `Logger` tee keeps. |
| `requests.bufferSize` | `500` | How many request traces are kept. |
| `requests.idHeader` | `'x-nest-mcp-request-id'` | The correlation header an agent sets to find a request's trace. Read, never echoed back. |
| `requests.headers` | `'names'` | Which request headers a trace keeps: `'none'`, `'names'` or `'full'`. Bodies never. |
| `serverInfo` | your app's `package.json` | `{ name, version }` the server reports in the MCP `initialize` handshake. |

Guards are instantiated inside the inspector's module, like any enhancer of its controller: their
dependencies must come from a global module or, in the async variants, from `imports`.

## Tools

| Group | Tools | Status |
|-------|-------|--------|
| `app` | `app_info`: Nest and Node versions, uptime, global prefix, versioning, endpoint path, instance scope, whether `snapshot` is on, which groups are live, and the instance's tool switches and `requests.headers` policy | ✅ |
| `graph` | `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles` | ✅ |
| `routes` | `routes_list`, `route_get` | ✅ |
| `logs` | `logs_tail`, `logs_levels` | planned |
| `requests` | `requests_list`, `request_trace` | planned |
| `events` / `schedule` | `events_listeners`, `events_recent`, `schedule_jobs` | planned |

Every tool returns JSON as a single text block. Errors come back as `{ "error": "<code>", "hint": "…" }`
with `isError: true`, plus what helps to retry (`candidates`, for example).

### Graph

Read from the serialized graph Nest keeps with `snapshot: true`, never from source. Every answer,
errors included, carries `scope`, the boundary the instance observes: a `forFeature` instance lists
only the modules in its closure, and the providers, dependencies and cycles among them.

| Tool | Input | Answers |
|------|-------|---------|
| `graph_modules` | `includeInternal?` | Each module: `global`, `dynamic`, provider and controller counts, `imports` |
| `graph_module` | `name`, `includeInternal?` | Imports, exports, providers (`token`, `scope`, `exported`), controllers, `importedBy` |
| `graph_providers` | `filter?`, `module?`, `scope?`, `includeInternal?` | Providers and injectables; enhancers carry `subtype` (`guard`, `pipe`, …) and, when registered globally, `global: true` |
| `graph_provider` | `token`, `module?`, `includeInternal?` | Module, injection scope, `dependsOn`, `dependents`, `initTimeMs` |
| `graph_cycles` | — | `cycles`: module import cycles and class injection cycles; `[]` when there are none |

- Tokens are text: a class by its name, a string or symbol token by its description. Instances are
  never returned.
- Nest's own modules and providers (`InternalCoreModule`, `ModuleRef`, `ApplicationConfig`, …) are
  hidden unless `includeInternal: true`.
- Modules that share a class name (two dynamic instances of one module, for example) are listed as
  `Name#1`, `Name#2` in the order Nest registered them; use those names as input.
- `dependsOn` and `dependents` count constructor and property injection. Enhancers attached with
  `@UseGuards` and friends are not dependencies; the `routes` tools report them.
- An unknown name answers `not_found` with up to five similar `candidates`; a token declared in several
  modules answers `ambiguous` with each `{ token, module }`, and `module` picks one.

### Routes and enhancers

Every HTTP route Nest registered whose controller is in the instance's scope, the inspector's own
endpoint included (a `forFeature` instance does not list it). Routes that an RPC layer implements as
controller handlers are ordinary routes; one served by a middleware of its own is not a route here.

| Tool | Input | Answers |
|------|-------|---------|
| `routes_list` | `filter?`, `method?`, `controller?`, `module?` | One entry per route: `method`, `path`, `Controller.handler`, and how many guards, interceptors, pipes and filters run on it |
| `route_get` | `method`, `path` | The route: `path`, `rawPath`, `version`, `controller`, `handler`, `module`, `guards`, `interceptors`, `pipes`, `filters`, `middlewares` |

- `path` is what the app serves, as Nest computed it: global prefix (unless the route is in its
  `exclude` list) and the URI version. `rawPath` is the controller and method paths alone, the one
  to use with header or media-type versioning. `route_get` takes either; a raw path shared by several
  versions answers `ambiguous` with the full paths.
- `version` is the handler's version, or the controller's, or `defaultVersion`; `VERSION_NEUTRAL` is
  `'neutral'`. Without versioning there is none.
- Each enhancer is `{ name, level }`, a class name and never an instance. Each list is in the order
  Nest runs it:

  | Level | Comes from |
  |-------|------------|
  | `global` | `app.useGlobalGuards(...)` and friends, and `APP_GUARD` / `APP_INTERCEPTOR` / `APP_PIPE` / `APP_FILTER` providers, in the order Nest registered them |
  | `controller` | `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` on the controller class |
  | `method` | The same decorators on the handler; then parameter pipes, which carry `param` (`'id'` for `@Param('id', ParseIntPipe)`, `#n` for an argument without a name) |

- **Filters are listed in the same order but resolved the other way round**: Nest tries the
  method's filters first, then the controller's, then the globals, and the first whose `@Catch`
  matches handles the exception.
- `middlewares` are the classes whose `forRoutes` path and method match the route's raw path.
  Plain paths match exactly; wildcards match by the prefix before them, and `exclude(...)` is not
  read, so the list is approximate (`route_get` says so in `middlewaresMatch`).

## How it works

- **Stateless Streamable HTTP.** Each `POST` gets its own MCP server and transport, answered and closed.
  `GET` and `DELETE` return 405 with `Allow: POST`: there are no sessions to stream to or tear down.
- **A Nest controller.** The endpoint is a regular controller mounted by the module, one class per
  instance, so your global prefix applies and the `guards` you configure get a real `ExecutionContext`.
- **Nothing leaves the process.** The server runs inside your app; the only network is the agent
  calling your app.

## Security

The endpoint shows the inside of your app. By default it is off in production and only accepts
loopback. If you turn it on elsewhere, put a guard in front of it:

```ts
NestMcpModule.forRoot({ enabled: true, localOnly: false, guards: [MyAuthGuard] });
```

Opening it to the network without guards works, and logs a warning at every startup.

## Limitations

- Verified with Express. Fastify is not supported in v1.
- `graph_*` and `routes_*` need `snapshot: true` in `NestFactory.create`; without it the module warns
  at startup and those tools return `snapshot_disabled` with the exact option to set.
- The log capture sees what goes through Nest's `Logger`. A logger that writes on its own (for
  example a request logger that bypasses Nest) is not captured.
- Clients that only speak stdio cannot connect: there is no stdio bridge in v1.
- `app_info` reports the Nest version the package resolves and the app name and version from the
  `package.json` of the working directory; set `serverInfo` if the app starts from elsewhere.

## License

MIT
