# Phase 5 — Request traces through guards, interceptors, pipes, filters and handler

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-04-logs.md`](./phase-04-logs.md)
> Next phase: [`phase-06-events-and-schedule.md`](./phase-06-events-and-schedule.md)

## Objective

The agent fires a request at the app and then asks where it went: which guards ran and what they
returned, which interceptors wrapped it, which pipes transformed which parameter, which handler served
it, whether an exception filter caught something, with timings per step, response status and total
duration. This is what no other Nest MCP gives and what matters most when debugging a 403 or a 500
([ADR-0002](../adr/0002-request-tracing-by-wrapping-enhancers.md)).

At the end: `GET /api/cats/abc` on the fixture app (fails `ParseIntPipe`) and `request_trace` of that
request shows `ApiKeyGuard: allowed (0.3 ms)` → `TimingInterceptor: enter` → `ParseIntPipe(id): threw
BadRequestException` → `status 400`, and the request appears in `requests_list`.

## Prerequisites

- [ ] Phase 4 closed.

## Closed decisions for this phase

- **Per-request context with `AsyncLocalStorage`** (`node:async_hooks`), opened by a middleware the
  module registers for all routes (`configure(consumer)`, `forRoutes('*')`) and closed on
  `res.on('finish'|'close')`, where `statusCode` and duration are recorded.
- **Wrapping instances, not classes**: at `onApplicationBootstrap`, walk `ModulesContainer` → each
  module → `injectables` and `providers`, and for each instance exposing `canActivate`, `intercept`,
  `transform` or `catch`, replace the method with a wrapper that, when a trace is active, records
  `{ kind, name, phase, startedAt, durationMs, outcome }` and calls the original. Global instances
  (`useGlobalX`, in `ApplicationConfig`) are wrapped the same way. Idempotent
  (`Symbol.for('nestjs-mcp.wrapped')`). Installed once per process by the first instance with
  `tools.requests` on.
- **The handler** is recorded by an `APP_INTERCEPTOR` of the module reading `context.getClass().name`
  and `context.getHandler().name`; registered first, it opens before the app's interceptors and closes
  after, giving the handler's time plus the app's interceptors.
- **Pipes and parameter**: `transform(value, metadata)` receives `ArgumentMetadata` with `data` (the
  parameter name) and `type` (`param`/`query`/`body`); recorded without the value.
- **What a trace stores**: method, **full URL** (query included), status, timings, controller, handler,
  steps, and request headers according to `requests.headers`: `none`, `names` (default: header names
  only) or `full` (names and values). Bodies never.
- **Correlation**: if the request carries `requests.idHeader` (default `x-nest-mcp-request-id`), that
  value is the trace `id`; otherwise one is generated. The header is **never echoed back** in the
  response. The agent sets it before calling and asks for the trace afterwards; without it,
  `requests_list` is the way in.
- **Scope**: traces whose handler's controller is in the instance's scope; `scope: 'app'` lifts it.
- **Ring buffer** of `requests.bufferSize` traces, shared; `tools.requests: false` installs nothing.
- **The inspector's own endpoint** is excluded from tracing (noise).

## Steps

### 1. Context and model

`src/requests/model.ts`:

```ts
type TraceStep = { kind: 'guard' | 'interceptor' | 'pipe' | 'filter' | 'handler'; name: string;
  level?: 'global' | 'controller' | 'method'; param?: string; paramType?: string;
  outcome: 'allowed' | 'denied' | 'ok' | 'threw' | 'caught'; error?: { name: string; message: string };
  startedAtMs: number; durationMs: number };
type RequestTrace = { id: string; method: string; url: string; route?: string; startedAt: string;
  durationMs?: number; statusCode?: number; controller?: string; handler?: string; module?: string;
  headers?: string[] | Record<string, string>; steps: TraceStep[] };
```

`src/requests/trace-context.ts`: `AsyncLocalStorage<RequestTrace>` and `current()`.

### 2. Middleware and buffer

`src/requests/trace.middleware.ts` (`NestMiddleware`): creates the trace, pushes it to the buffer on
finish, `als.run(trace, next)`. Excludes the inspector endpoints.

### 3. Enhancer wrapping

`src/requests/wrap-enhancers.ts`: `wrapEnhancers(modulesContainer, applicationConfig)`. For `catch`
(filters): `outcome: 'caught'` with `error.name`. For `canActivate` returning an `Observable` or a
`Promise`, wrap the result. For `intercept`, record `enter` on call and `exit` when the returned
`Observable` emits or errors (`tap`/`finalize`).

### 4. Handler interceptor

`src/requests/handler.interceptor.ts`, provided as `APP_INTERCEPTOR`; fills `controller`, `handler`,
`module` and `route` (from `context.switchToHttp().getRequest().route?.path` on Express).

### 5. Tools

`src/tools/requests.tools.ts`:

| Tool | Input | Output |
|------|-------|--------|
| `requests_list` | `{ limit?: number (≤200, default 50); method?: string; path?: string (substring); status?: number; minStatus?: number; scope?: 'instance'\|'app' }` | Latest requests: `id`, method, url, `statusCode`, `durationMs`, `Controller.handler`, step count |
| `request_trace` | `{ id: string }` | The full `RequestTrace`, steps in order |

### 6. Tests and docs

`test/requests.spec.ts` with `fetch` against the fixture: the happy path (`guard allowed → interceptor
→ pipe ok → handler ok → 200`), the guard denial (`denied → 403`, no later steps), the pipe failure
(`threw → 400`), the filter (`caught`), correlation through the incoming header with no echo in the
response, the `headers` option in its three values, `forFeature` scoping, and the inspector endpoint
absent. "Request traces" section in the README, with what is and is not stored.

## Files

### Created

- `src/requests/{model.ts,trace-context.ts,trace.middleware.ts,wrap-enhancers.ts,handler.interceptor.ts}`
- `src/tools/requests.tools.ts`, `test/requests.spec.ts`

### Modified

- `src/nest-mcp.module.ts` (implements `NestModule.configure`), `src/nest-mcp.bootstrap.ts`,
  `src/tools/app.tools.ts`, `README.md`

## Verification / definition of done

- [ ] `requests.spec.ts` green with every case.
- [ ] Ten concurrent `fetch`es do not mix steps: each trace holds only its own.
- [ ] A wrapped guard behaves exactly as unwrapped: same return values, same exception, correct `this`
      (a guard using an injected property proves it).
- [ ] With `tools.requests: false`, no method in `ModulesContainer` carries the wrapped mark.
- [ ] The response of a request carrying `x-nest-mcp-request-id` does not contain that header.
- [ ] `yarn build`, `lint`, `type-check` green.

## Likely stumbles

- **`ModulesContainer` in Nest 10 vs 11**: `module.injectables` and `module.providers` are
  `Map<token, InstanceWrapper>`; `wrapper.instance` may be `undefined` for `REQUEST`/`TRANSIENT`
  providers (created per request: do not wrap; report the limitation). Nest 11 adds
  `wrapper.isNotMetatype`.
- **Class guards without their own instance**: `@UseGuards(ApiKeyGuard)` makes Nest create the instance
  as an `injectable` of the module; it lives in `injectables`, not `providers`.
- **`canActivate` returning an `Observable`**: do not block; `tap` for the record, never convert the
  result.
- **`res.on('finish')`** does not fire on aborted streams: listen to `close` too and record whatever
  status there is.
- **An app already using `x-request-id`** (request loggers, proxies): open decision 1 of the master plan; decide here
  whether to accept it as an alias and record it under "Hot decisions".

## Phase closure — two mandatory commits

Commit 1: `feat(nestjs-mcp): trace each request through guards, interceptors, pipes and filters (Phase 5)`.
Commit 2: `chore(nestjs-mcp): close phase 5`. Then, if a host embeds this repo as a submodule, its pointer on the host side.

## Notes for the next session (Phase 6)

- `wrapEnhancers` already walks `ModulesContainer`; phase 6 walks the same for listeners and jobs.
  Extract a `forEachInstance(modulesContainer, fn)` into `support/`.
