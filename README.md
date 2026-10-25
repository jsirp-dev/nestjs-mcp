# @jsirp/nestjs-mcp

Runtime [MCP](https://modelcontextprotocol.io) inspector embedded in your NestJS app, for coding agents.

Add one module and your running app opens an MCP endpoint, on a port of its own, that tells an agent (Claude Code, Cursor,
any MCP client) what Nest actually built: the module and provider graph, every route with the guards,
interceptors, pipes and filters it goes through, what the app's `Logger` is writing right now, which
enhancers a given request passed through and how long each took, event listeners and scheduled jobs.
Nothing to install on the agent side: it points at `http://127.0.0.1:7777/`.

> Status: **0.1.0 in development**. Today the endpoint, `app_info`, the graph, routes and logs work;
> the other tool groups land one by one (see [Tools](#tools)).

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

At startup the module opens the inspector's own HTTP listener, next to your app's server and
independent of it, and logs the endpoint, with context `NestMcp`:

```
[NestMcp] Inspector listening at http://127.0.0.1:7777/
```

Nothing of your app runs in front of it: no global prefix, no versioning, no middlewares, no global
guards, interceptors, pipes or filters. Your auth guard never sees an inspector call, your request
logger never logs one, your OpenAPI document does not list it, and the inspector's calls never show
up in its own request traces. The listener closes with the app (`app.close()`).

### One module on its own endpoint

`forFeature` mounts an instance whose scope is the module that imports it and everything that module
imports. `path` is required. Any number of instances may coexist, each with its own path,
`authorize` and switches, all on the same listener: `forRoot` answers at `/`, each `forFeature` at its
`path` (`http://127.0.0.1:7777/cats` below).

The scope is resolved from the serialized graph at the first tool call, so it needs `snapshot: true`
too: `app_info.scope` then reads `{ "kind": "module", "module": "CatsModule" }`. Without `snapshot`, it
reads `{ "kind": "module", "module": null, "error": "scope_unresolved", "fallback": "app" }`. The
closure leaves out Nest's internal modules and the instance's own module.

```ts
@Module({
  imports: [NestMcpModule.forFeature({ path: 'cats' })],
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

**`path` is given statically**, next to `useFactory`, not returned by it, so a `forFeatureAsync`
without it fails at once. Everything else, `listen` and `authorize` included, may come from the
factory. `enabled` may go either way: given statically and `false`, nothing is registered; returned
by the factory as `false`, the instance does not join the listener (with no other instance, no
listener is opened) and nothing else is installed.

## Point your agent at it

Claude Code:

```bash
claude mcp add --transport http my-nest-app http://127.0.0.1:7777/
```

Or any client that reads an `mcpServers` file:

```json
{
  "mcpServers": {
    "my-nest-app": { "type": "http", "url": "http://127.0.0.1:7777/" }
  }
}
```

The URL does not depend on your app's port, prefix or versioning. Two apps on one machine need two
ports: give each its own `listen.port`.

## Options

All optional, except `path` in `forFeature`.

| Option | Default | What it does |
|--------|---------|--------------|
| `enabled` | `process.env.NODE_ENV !== 'production'` | The switch. When `false` the instance registers nothing and opens nothing. It is a default, not a rule: set it to `true` wherever you want the inspector and protect it with `authorize`. |
| `listen` | `{ host: '127.0.0.1', port: 7777 }` | The inspector's own HTTP listener, shared by every instance of the app: set it on one instance, or the same on all (two different ones fail at startup). `port: 0` picks a free port; the startup log and `app_info.mcpUrl` say which. A port in use fails at startup with an error naming `listen.port`. |
| `path` | `'/'` for `forRoot`; required for `forFeature` | Route of the instance on the listener. No prefix or versioning applies. Two instances on one path fail at startup. |
| `authorize` | none | `(req) => boolean \| Promise<boolean>`, called with the raw Node `IncomingMessage` before each request to this instance is answered. `false`, or a throw (logged), answers 403. |
| `tools` | all `true` | One switch per tool group: `{ graph, routes, logs, requests, events, schedule, runs }`. A group switched off registers no tools and installs nothing. |
| `logs.bufferSize` | `2000` | Size of the ring buffer `logs_tail` reads. |
| `logs.sink` | none | What `createLogSink()` returned, added to your own logger's outputs: that logger's lines enter the buffer too. See [Reading your own logger](#reading-your-own-logger). |
| `logs.capture` | `'both'` | What fills the buffer: `'nest'` (Nest's `Logger`, through the tee), `'sink'` (only `logs.sink`; no tee is installed) or `'both'`. `'sink'` requires `logs.sink`. |
| `logs.normalize` | none | `(record) => entry \| undefined`: maps the sink's records of a format the built-in mapping does not read. |
| `requests.bufferSize` | `500` | How many request traces are kept. |
| `requests.idHeader` | `'x-nest-mcp-request-id'` | The correlation header an agent sets to find a request's trace. Read, never echoed back. |
| `requests.headers` | `'names'` | Which request headers a trace keeps: `'none'`, `'names'` or `'full'`. Bodies never. |
| `runs.bufferSize` | `500` | How many job and listener runs are kept. One buffer per app: the first instance that installs it sets the size. |
| `serverInfo` | your app's `package.json` | `{ name, version }` the server reports in the MCP `initialize` handshake. |

`authorize` is a plain function, not a Nest guard: there is no `ExecutionContext`. Close over what
it needs, or build it in a `forRootAsync` factory from injected services:

```ts
NestMcpModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    listen: { host: '0.0.0.0', port: 7777 },
    authorize: (req) => req.headers['x-inspector-key'] === config.get('INSPECTOR_KEY'),
  }),
});
```

## Tools

| Group | Tools | Status |
|-------|-------|--------|
| `app` | `app_info`: Nest and Node versions, uptime, global prefix, versioning, endpoint path and URL (`mcpPath`, `mcpUrl`), instance scope, whether `snapshot` is on, which groups are live, and the instance's tool switches and `requests.headers` policy | ✅ |
| `graph` | `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles` | ✅ |
| `routes` | `routes_list`, `route_get` | ✅ |
| `logs` | `logs_tail`, `logs_levels` | ✅ |
| `requests` | `requests_list`, `request_trace` | ✅ |
| `events` | `events_listeners`, `events_recent` (only with `@nestjs/event-emitter` and its module) | ✅ |
| `schedule` | `schedule_jobs` (only with `@nestjs/schedule` and its module) | ✅ |
| `runs` | `runs_list`, `run_get` (only with `@nestjs/schedule` or `@nestjs/event-emitter` and its module) | ✅ |

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

Every HTTP route Nest registered whose controller is in the instance's scope. The inspector is not
one of them: it is not a controller. Routes that an RPC layer implements as
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

### Logs

At startup the module wraps the logger your app set (with `app.useLogger`, the `logger` option of
`NestFactory.create`, or Nest's default `ConsoleLogger`) in a **transparent tee**: every call to
Nest's `Logger` reaches your logger exactly as it was made, and a copy goes to an in-memory ring
buffer of `logs.bufferSize` entries. Nothing is masked, filtered or altered, and nothing is persisted.
If your services log through a logger of their own (`PinoLogger`, winston…), hand its output to the
same buffer with a [log sink](#reading-your-own-logger). The tee and the buffer are installed once
per process and shared by every instance: the first instance that installs them decides
`logs.bufferSize`, and an instance with `logs.capture` other than `'sink'` installs the tee, so give
every instance with the `logs` group on the same `logs`. Switching the `logs` group off in every
instance installs nothing.

| Tool | Input | Answers |
|------|-------|---------|
| `logs_tail` | `limit?` (≤ 500, default 100), `level?`, `minLevel?`, `context?`, `contains?`, `source?` (`'nest'` or `'sink'`), `requestId?`, `runId?`, `sinceSeq?`, `scope?` (`'instance'` or `'app'`) | `entries`, oldest first, each `{ seq, source, timestamp, level, context, message, stack?, requestId?, runId? }`; `lastSeq`, to pass as `sinceSeq` next time; `more` when a page after `sinceSeq` was cut at `limit`; `dropped` when entries after `sinceSeq` already left the buffer |
| `logs_levels` | — | `levels` Nest's logger has on (`null` if it has no `isLevelEnabled`, or with `capture: 'sink'`), `capture`, the `buffer` (`size`, `length`, `lastSeq`) and the `sink` (`connected`, `received`, `errors`, `lastError?`; `null` without one) |

- Levels are Nest's: `verbose`, `debug`, `log`, `warn`, `error`, `fatal`. `minLevel` keeps that level
  and the more severe ones.
- `source` says where an entry came from: `'nest'` for Nest's `Logger`, `'sink'` for your logger
  through the sink.
- `context` is the trailing string argument, as `ConsoleLogger` reads it: the class name for a
  `new Logger(MyService.name)`. In `error`, the multi-line string before it is the `stack`.
  Non-string messages are stored as JSON, capped at 2000 characters.
- `seq` grows by one per entry and never repeats. Without `sinceSeq` the answer is the newest
  `limit` entries; with it, the oldest `limit` after it, so paging never skips or repeats one.
- A **`forFeature` instance keeps only entries whose context is the name of a class in its scope**
  (controllers, providers, injectables) and says so in `scopeFilter`. It is approximate: a context that
  is not a class name, or a class name shared with another module, is judged by name alone.
  `scope: 'app'` lifts the filter.
- A level your logger reports as disabled (`isLevelEnabled`) is forwarded as usual but not copied,
  so the buffer holds what your logger keeps. With `logger: false` nothing is printed, as before,
  and the buffer still fills.
- The inspector's own lines (context `NestMcp`) are in the buffer too.
- **`requestId`** is the id of the request being traced when the entry was captured (the
  correlation header's value, or the generated id `requests_list` shows); `logs_tail({ requestId })`
  reads one request's lines and [`request_trace`](#request-traces) lists them. It is read from the
  request's async context at the moment the tee or the sink receives the line, so an entry written
  outside a request has none, and so has a sink line delivered outside that context: one your logger
  hands over later (an asynchronous transport, a worker-thread destination such as
  `pino.transport`) or one the sink held before it was connected. A line logged by a middleware
  that runs after one that lost the async context (and before the first guard) has none either. It
  needs the `requests` group on; without it no entry carries one.
- **`runId`** is, likewise, the id of the job or listener [run](#runs) executing when the entry was
  captured; `logs_tail({ runId })` and `run_get` read a run's lines. A line a listener writes while
  it runs inside a request carries both ids. It needs the `runs` group on.

### Reading your own logger

The tee sees only what goes through Nest's `Logger`. A service that logs through a logger of its own
writes past it: with `nestjs-pino`, this is what reaches `logs_tail`:

| Written through | Without a sink | With a sink |
|-----------------|----------------|-------------|
| Nest's `Logger` (`new Logger(ctx)`, and the `Logger` nestjs-pino installs with `app.useLogger`) | yes (`source: 'nest'`) | yes (`'nest'`, `'sink'` or both, per `logs.capture`) |
| `PinoLogger`, `@InjectPinoLogger()` | no | yes (`source: 'sink'`) |
| The `pino-http` request lines | no | yes (`source: 'sink'`) |

`createLogSink()` returns a **log sink**: a writable stream your logger writes to like any other
output, plus a `record(entry)` function for loggers that hand over objects. Create it before your
logger, add it to the logger's outputs and pass it as `logs.sink` (from `forRoot`, or returned by a
`forRootAsync` factory). The sink only reads: your other outputs get exactly what they got before,
and it never throws into your logger (a failure is swallowed and counted in `logs_levels.sink`).

**pino, with `nestjs-pino`.** Write to stdout and to the sink with `pino.multistream`:

```ts
import { Module } from '@nestjs/common';
import { createLogSink, NestMcpModule } from '@jsirp/nestjs-mcp';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';

const logSink = createLogSink();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: [
        { level: 'debug' },
        pino.multistream([
          { stream: process.stdout, level: 'debug' },
          { stream: logSink, level: 'debug' },
        ]),
      ],
    }),
    // app.useLogger(app.get(Logger)) routes Nest's Logger through pino too: read it once, from the sink.
    NestMcpModule.forRoot({ logs: { sink: logSink, capture: 'sink' } }),
  ],
})
export class AppModule {}
```

The sink must run in your process: add it to `multistream` (or as a plain `stream`), not as a
`pino.transport` target, which runs in a worker thread.

**winston, with or without `nest-winston`.** A transport that hands each record to `record`:

```ts
import { createLogSink, NestMcpModule } from '@jsirp/nestjs-mcp';
import * as winston from 'winston';
import Transport from 'winston-transport';

const logSink = createLogSink();

class InspectorTransport extends Transport {
  override log(info: unknown, next: () => void): void {
    logSink.record(info);
    next();
  }
}

export const logger = winston.createLogger({
  transports: [new winston.transports.Console(), new InspectorTransport()],
});

// In AppModule. With WinstonModule as the app logger, Nest's Logger goes through winston too:
NestMcpModule.forRoot({ logs: { sink: logSink, capture: 'sink' } });
```

What the sink reads out of the box:

- **pino and bunyan JSON lines**: the numeric `level` (10 → `verbose`, 20 → `debug`, 30 → `log`,
  40 → `warn`, 50 → `error`, 60 → `fatal`), `msg`, `time`, `context` (what nestjs-pino and
  nest-winston set) or else `name`, and the stack of `err`.
- **Objects passed to `record`**, such as winston's: a level name (`info` → `log`, `warning` →
  `warn`, `trace` and `silly` → `verbose`…, colour codes ignored), `message`, `timestamp`, `context`.
- **Plain text**: each line is a `log` entry with the line as its message and no context.

One write may carry several lines; each is one entry. Anything else maps with `logs.normalize`,
which receives the parsed JSON line, the plain-text line as a string, or what you passed to
`record`, and returns `{ level?, message?, context?, timestamp?, stack? }`, or `undefined` to use
the built-in mapping:

```ts
NestMcpModule.forRoot({
  logs: {
    sink: logSink,
    normalize: (record) =>
      typeof record === 'object' && record !== null && 'severity' in record
        ? { level: String(record.severity), message: (record as { text?: string }).text }
        : undefined,
  },
});
```

Which `logs.capture` to pick:

- `'both'` (the default): your services log through their own logger and Nest's `Logger` prints
  elsewhere (Nest's `ConsoleLogger`, for example). Nothing is duplicated.
- `'sink'`: Nest's `Logger` also writes through the logger the sink is attached to (nestjs-pino's or
  nest-winston's logger set with `app.useLogger`). With `'both'` each of those lines would be there
  twice, once per `source`. No tee is installed, so `logs_levels.levels` is `null`.
- `'nest'`: the sink is ignored.

What arrives before the app starts is held by the sink (up to 1000 entries) and delivered when the
inspector connects it; when the app closes, the sink is disconnected and holds again. With the
inspector disabled the sink is never connected, so it only keeps those last 1000 lines; leave it out
of your logger's outputs where you never enable the inspector.

### Request traces

Fire a request at the app, then ask where it went. Set the correlation header
(`x-nest-mcp-request-id`, or your `requests.idHeader`) to an id of your choosing and read the trace
by that id; without the header the request gets a generated id, and `requests_list` finds it.

```bash
curl -H 'x-nest-mcp-request-id: try-1' http://localhost:3000/api/cats/abc
# then, from the agent: request_trace { "id": "try-1" }
```

| Tool | Input | Answers |
|------|-------|---------|
| `requests_list` | `limit?` (≤ 200, default 50), `method?`, `path?` (substring of the URL), `status?`, `minStatus?`, `scope?` (`'instance'` or `'app'`) | `requests`, oldest first, each `{ id, method, url, startedAt, statusCode, durationMs, handler, module, steps }` (`inFlight: true` while it runs); `matched` |
| `request_trace` | `id`, `scope?` | The trace: `method`, `url`, `route`, `statusCode`, `durationMs`, `controller`, `handler`, `module`, `headers`, its `steps` in order and, with the `logs` group on, its `logs`; with several traces sharing an id, the latest |

Each step is `{ kind, name, level?, outcome, error?, startedAtMs, durationMs }`, timed from the start
of the request:

| `kind` | Recorded | `outcome` |
|--------|----------|-----------|
| `guard` | When `canActivate` returns (or its Promise or Observable settles) | `allowed`, `denied` (returned `false`, Nest answers 403) or `threw` |
| `interceptor` | Twice: `phase: 'enter'` when `intercept` is called, `phase: 'exit'` when the Observable it returned answers; `shortCircuited: true` on the exit when it answered without calling `next.handle()` | `ok` or `threw` |
| `pipe` | Per argument, with `param` as `route_get` shows it (`'id'`, or `#n` for an argument without a name; absent when two same-typed unnamed arguments cannot be told apart) and `paramType` (`param`, `query`, `body`, `custom`); never the value | `ok` or `threw` |
| `handler` | Named `Controller.handler` by the method's property key, as `routes_list` names it (also when a decorator replaced the method with a wrapper), placed where it ran: after the pipes, before the interceptors' exits. Absent when a pipe or an interceptor stopped the request first | `ok` or `threw` |
| `filter` | When an exception filter of yours handles an exception, with that exception in `error` | `caught`, or `threw` if the filter itself threw |

So `GET /api/cats/abc` on a route with an API-key guard, a timing interceptor and `ParseIntPipe`
reads `ApiKeyGuard allowed → TimingInterceptor enter → ParseIntPipe(id) threw BadRequestException →
TimingInterceptor exit threw`, status 400.

- **What a trace stores**: method, the URL with its query string, route pattern, status, timings,
  controller, handler and steps; request headers per `requests.headers`: `'none'`, `'names'` (the
  default, names only) or `'full'` (names and values, credentials included: choose it knowingly).
  **Bodies are never stored**, neither of requests nor of responses.
- **The correlation header is read, never echoed back**: the response carries nothing it did not
  carry before. To reuse an id your app already propagates (`x-request-id` from a proxy or request
  logger), set `requests.idHeader: 'x-request-id'`.
- `level` (`global`, `controller`, `method`) comes from the route's enhancer chain, so it needs
  `snapshot: true`, like `module`. Without it the steps are there and those fields are not.
- A **`forFeature` instance lists only traces whose handler is in its scope**; a request that matched
  no route has no handler and is seen from app scope only. `scope: 'app'` lifts the filter.
- The inspector's own calls are never traced: they arrive on its listener, not through Nest. One ring buffer of `requests.bufferSize` traces per
  app, shared by its instances; the first instance with the `requests` group on decides
  `requests.*`.
- Enhancers in `REQUEST` or `TRANSIENT` scope have no long-lived instance to observe; a trace lists
  the ones on its route in `notTraced`.
- **`logs`** (with the `logs` group on) are the [log entries](#logs) written during this request that
  the logs buffer still holds, oldest first, as `logs_tail` answers them: Nest's own exceptions
  handler logs an unhandled error inside the request, so a 500 lists that line too. At most 200, the
  newest, with `logsTruncated: true` when more matched; `logsDropped: true` when the buffer already
  discarded some of them, so the list is not taken for the whole. Lines of an earlier request that
  reused the same id are not listed. They are listed whatever the instance's scope, since the trace
  itself already is in scope. Lines are matched as `requestId` says, with its limits.

### Events

With `@nestjs/event-emitter` installed and `EventEmitterModule` imported, the inspector lists who
listens to what and records what was emitted. Without the package, or without its module, there are
no `events_*` tools and `app_info.tools.events` is `false`.

| Tool | Input | Answers |
|------|-------|---------|
| `events_listeners` | `event?`, `scope?` (`'instance'` or `'app'`) | `listeners`, each `{ event, className, methodName, module, options?, requestScoped?, lastRun? }`; `wildcard` (whether the emitter resolves wildcards) |
| `events_recent` | `limit?` (≤ 500, default 50), `event?` | `entries`, oldest first, each `{ seq, event, method, timestamp, listeners }`; `emissions: 'app-wide'` |

- **Listeners come from the `@OnEvent` metadata** of every provider and controller, request-scoped
  ones included. With `event`, a listener matches when its pattern contains the text or when the
  emitter itself would call it for that event: with `wildcard: true`, `events_listeners { "event":
  "cat.adopted" }` returns the `cat.*` listeners too.
- **Emissions are recorded by wrapping `emit` and `emitAsync`** on the app's `EventEmitter2`: the event
  name, the method, the time and `listenerCount(event)` at that moment. **Payloads are never kept.**
  The wrapper returns exactly what the original returned (the boolean, the same promise) and throws
  what it threw. `event` filters by substring or, as a pattern, through the emitter (`cat.*`).
- A `forFeature` instance lists only listeners declared in its scope. Emissions have no module, so
  every instance sees all of them; one buffer of the latest 500 per emitter, shared by the instances.

### Scheduled jobs

With `@nestjs/schedule` installed and `ScheduleModule` imported, the inspector lists what the app's
`SchedulerRegistry` holds. Without the package, or without its module, there is no `schedule_jobs`
and `app_info.tools.schedule` is `false`.

| Tool | Input | Answers |
|------|-------|---------|
| `schedule_jobs` | `kind?` (`'cron'`, `'interval'` or `'timeout'`), `scope?` (`'instance'` or `'app'`) | `jobs`, each `{ kind, name, className?, methodName?, module?, expression?, timeZone?, everyMs?, delayMs?, running?, lastFiredAt?, nextRun?, lastRun? }` |

```jsonc
// schedule_jobs { "kind": "cron" }, for @Cron('0 3 * * *', { name: 'cleanup' }) on CatsService
{ "scope": { "kind": "app" }, "jobs": [{ "kind": "cron", "name": "cleanup", "className": "CatsService",
  "methodName": "cleanup", "module": "CatsModule", "expression": "0 3 * * *", "running": true,
  "nextRun": "2026-10-26T03:00:00.000+01:00" }] }
```

- **The registry is read on every call**: cron jobs (`expression`, `running`, `lastFiredAt` as the
  `CronJob` knows it, and
  `nextRun` while running), intervals (`everyMs`) and timeouts (`delayMs`; `running: false` once
  fired or cleared), the ones the app added with `addCronJob`/`addInterval`/`addTimeout` included.
  `timeZone` appears when it differs from the process's own.
- **Class, method and module come from the `@Cron`/`@Interval`/`@Timeout` metadata**, matched to
  the registry by name; a decorator without a name, which the registry knows by a generated id, is
  matched by its expression or period when exactly one job has it.
- A `forFeature` instance lists only jobs declared by classes in its scope. A job the app added to
  the registry by hand has no class, so only `scope: 'app'` (or a `forRoot` instance) lists it.
- With the `runs` group on, a decorated job carries `lastRun` (`{ id, startedAt, outcome,
  durationMs? }`), its latest [run](#runs); so does each listener of `events_listeners`.

### Runs

With `@nestjs/schedule` or `@nestjs/event-emitter` installed and its module imported, the inspector
records each execution (a *run*) of the decorated jobs and of the `@OnEvent` listeners: what ran, when,
for how long, and whether it threw, with the error, even though the scheduler and the emitter catch it
and only log it. Without either package, or with `tools.runs: false`, nothing is wrapped, there are no
`runs_list` or `run_get` and `app_info.tools.runs` is `false`.

| Tool | Input | Answers |
|------|-------|---------|
| `runs_list` | `kind?` (`'cron'`, `'interval'`, `'timeout'` or `'listener'`), `name?`, `event?`, `outcome?` (`'running'`, `'ok'` or `'threw'`), `limit?` (≤ 500, default 50), `scope?` (`'instance'` or `'app'`) | `runs`, oldest first, each `{ id, kind, className, methodName, module, name?, event?, startedAt, durationMs?, outcome, error?, requestId? }` |
| `run_get` | `id`, `scope?` | `run`: the same fields, and `logs` (at most 200, the newest), `logsTruncated?`, `logsDropped?` with the `logs` group on |

```jsonc
// runs_list { "outcome": "threw" }, for @Cron('0 5 * * *', { name: 'purge' }) that threw
{ "scope": { "kind": "app" }, "runs": [{ "id": "…", "kind": "cron", "className": "JobsService",
  "methodName": "purge", "module": "JobsModule", "name": "purge",
  "startedAt": "2026-10-26T05:00:00.002Z", "durationMs": 1.42, "outcome": "threw",
  "error": { "name": "Error", "message": "purge failed" } }] }
```

- **Only what the scheduler or the emitter starts is a run.** A call your code makes to the method
  itself is not recorded. `name` matches the job's decorator name or `Class.method`; `event` matches a
  substring of the emitted event or, as a pattern, what the emitter would match (`cat.*`).
- **Never the event payload or the job's arguments.** A run keeps the class, method, module, job
  name or event, times, outcome and the error's name and message; `requestId` when it started inside
  a traced request.
- **The error line the scheduler (`Scheduler`) or the emitter (`Event`) logs after the method threw
  is written outside the run**, so it is in `logs_tail` without the `runId`; the run's `error` has
  what was thrown.
- A `forFeature` instance lists only runs of classes in its scope. One buffer of the latest
  `runs.bufferSize` runs per app, shared by the instances; a run in progress has `outcome: 'running'`.

## How it works

- **Stateless Streamable HTTP.** Each `POST` gets its own MCP server and transport, answered and closed.
  `GET` and `DELETE` return 405 with `Allow: POST`: there are no sessions to stream to or tear down.
- **Its own listener.** A plain `node:http` server, one per app, opened by the first instance at
  `onApplicationBootstrap` and closed when the app closes. It routes each request by path to its
  instance, runs that instance's `authorize`, and hands the raw request to the MCP transport. No
  controller is registered, so nothing of the app (prefix, versioning, middlewares, enhancers,
  OpenAPI generation) touches it, and it works in an app that never calls `listen`.
- **Traces by wrapping enhancer instances.** With the `requests` group on, the module wraps, in place,
  `canActivate`, `intercept`, `transform` and `catch` on the guard, interceptor, pipe and filter
  instances Nest built (global, per controller and per route) before Nest builds the routes. Each
  wrapper records a step into the current request's trace, held in an `AsyncLocalStorage` that a
  middleware opens, and returns exactly what the original returned, with the same `this` and the
  same exceptions. When a middleware after it loses that async context (one that calls `next` from
  a stream callback, as multer before 2.3 does), guards, interceptors and filters find the trace by
  the request object and run the rest of the request back inside it. It also adds one global interceptor of its own, which names the handler. With the
  group off, nothing is wrapped and neither is installed.
- **Emissions by wrapping the emitter.** With the `events` group on and the app's `EventEmitter2` in
  the container, `emit` and `emitAsync` are replaced on that instance, once, by functions that record
  the event name and listener count and then call the original. Nothing else of the emitter changes.
- **Scheduled jobs by reading the registry.** With the `schedule` group on, the module finds the
  app's `SchedulerRegistry` and reads it per call. Nothing is wrapped, started or stopped.
- **Runs by wrapping job and listener methods.** With the `runs` group on, before any
  `onModuleInit`, the module defines on each long-lived provider or controller with a `@Cron`,
  `@Interval`, `@Timeout` or `@OnEvent` method an own property wrapping it, carrying the original's
  metadata so the scheduler and the emitter still find the decorators. The scheduler binds the job
  wrapper at its `onModuleInit`, and at `onApplicationBootstrap` the module takes the property back,
  so your own calls go to the original. Listener wrappers stay, and record only when called inside an
  `emit`/`emitAsync` (wrapped to know the event) for an event the method listens to. Each wrapper
  returns what the original returned (the same promise) and throws what it threw
  ([ADR-0006](docs/adr/0006-runs-by-wrapping-job-and-listener-methods.md)).
- **Nothing leaves the process.** The server runs inside your app; the only network is the agent
  calling the inspector's listener.

## Security

The inspector shows the inside of your app. By default it is off in production and its listener
binds to loopback (`127.0.0.1`), so only the machine itself reaches it. If you open it beyond
loopback, check every request with `authorize`:

```ts
NestMcpModule.forRoot({
  enabled: true,
  listen: { host: '0.0.0.0' },
  authorize: (req) => req.headers.authorization === `Bearer ${process.env.INSPECTOR_TOKEN}`,
});
```

Listening beyond loopback without `authorize` works, and logs a warning at every startup. Your app's
own guards do not run on the inspector: to put your existing authentication in front of it, call it
from `authorize` or put a reverse proxy before the listener.

## Limitations

- Verified with Express. Fastify is not supported in v1.
- `graph_*` and `routes_*` need `snapshot: true` in `NestFactory.create`; without it the module warns
  at startup and those tools return `snapshot_disabled` with the exact option to set.
- Without a [log sink](#reading-your-own-logger), the log capture sees only what goes through Nest's
  `Logger`: with `nestjs-pino`, the lines written through `PinoLogger`/`@InjectPinoLogger()` and the
  `pino-http` request lines are not captured. With a sink, only the fields the sink maps are kept
  (level, message, context, time, stack); the other fields of a record (`req`, `res`, bindings) are
  not.
- The tee is installed during `app.init()` (in `onModuleInit`). Lines written before that, including
  the ones `bufferLogs: true` holds until `useLogger` flushes them, and the `onModuleInit` hooks of
  modules Nest initialises before the inspector's, are not in the buffer. A `useLogger` after the app
  started replaces the tee, and capture stops. A log sink is not affected: it holds what arrives
  before the inspector connects it.
- With Nest's default logger, every `Logger` prints through one shared `ConsoleLogger`; a per-instance
  `new Logger(context, { timestamp: true })` loses its elapsed-time suffix.
- Request tracing needs the app's routes to be built after the module is configured, which is the
  normal `NestFactory.create` → `listen` (or `init`) bootstrap. Global enhancers added after
  `app.init()` are not traced (Nest does not run them on existing routes either). Enhancer instances
  that are frozen are left unwrapped. Nest's built-in exception handler is not a step: an exception no
  filter of yours caught shows in the step that threw and in the status.
- Requests that do not go through a Nest middleware (outside the global prefix, or served before
  Nest's router) are not traced.
- Emissions are recorded from the moment the module is configured (before any `onModuleInit`); an
  emitter the app creates on its own, outside `EventEmitterModule`, is not observed. Listeners added
  by hand with `emitter.on(...)` count in `listeners` but are not in `events_listeners`, which reads
  `@OnEvent` metadata.
- `schedule_jobs` lists what `SchedulerRegistry` holds: a decorated job `ScheduleModule` did not
  register (a request-scoped provider, a kind switched off in `forRoot`) is not listed. Periods and
  pending state of intervals and timeouts are read from Node's timer objects.
- Runs are not recorded for request-scoped listeners (the emitter builds an instance per emission)
  nor for jobs your app adds to `SchedulerRegistry` itself, which run its own callbacks. A method
  that is both a job and a listener records a job run when the scheduler calls it outside an
  emission.
- Clients that only speak stdio cannot connect: there is no stdio bridge in v1.
- `app_info` reports the Nest version the package resolves and the app name and version from the
  `package.json` of the working directory; set `serverInfo` if the app starts from elsewhere.

## Contributing

The package is its own Yarn 4 project (`packageManager` pins the version; `corepack enable` once).

```bash
yarn install --immutable
yarn format-check && yarn lint && yarn type-check
yarn build && yarn test   # the suite imports dist/index.cjs: build first
```

The devDependencies run the suite on Nest 11. To run it on Nest 10, install the four Nest packages at
once (so the tree holds one major), run the suite, then throw the change away:

```bash
yarn add -D @nestjs/common@^10 @nestjs/core@^10 @nestjs/platform-express@^10 @nestjs/testing@^10
yarn build && yarn test
git checkout package.json yarn.lock && yarn install
```

CI (`.github/workflows/ci.yml`) runs format, lint, type-check, build and the suite on every push to
`main` and every pull request, on Nest 10 and 11, each on Node 20 and 22. Branch protection
on `main` requires the four `ci` checks to pass; a maintainer sets it in the repository settings, it
is not part of this repo.

Releases are cut by a maintainer, never by the workflow: add a `## x.y.z` section at the top of
`CHANGELOG.md`, run `npm version patch|minor|major` (commit and `vx.y.z` tag), then
`git push --follow-tags`. The tag starts `.github/workflows/release.yml`: the full CI matrix, then
`npm publish --provenance --access public` (with the `NPM_TOKEN` repository secret) and a GitHub
release whose notes are that `CHANGELOG.md` section. A manual run of the workflow, or a tag ending in
`-test`, does all of it with `npm publish --dry-run` and creates no release.

## License

MIT
