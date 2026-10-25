# Phase 4 — Live logs from the app's `Logger`

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-03-routes-and-enhancers.md`](./phase-03-routes-and-enhancers.md)
> Next phase: [`phase-05-request-traces.md`](./phase-05-request-traces.md)

## Objective

The agent reads what the app writes through Nest's `Logger`, whatever implementation the app set with
`app.useLogger` (pino, winston, the default `ConsoleLogger`…), without the app changing anything: the
inspector installs a **transparent tee** that forwards every entry to the original logger untouched and
copies it to an in-memory ring buffer. Nothing is masked, filtered or altered.

At the end: with the fixture app writing through `Logger`, `logs_tail({ level: 'warn' })` returns the
latest entries of that level with `timestamp`, `level`, `context` and `message`, and the original logger
still receives exactly what it did before.

## Prerequisites

- [x] Phase 3 closed.

## Closed decisions for this phase

- **Installed once per process**, by the first enabled instance whose `tools.logs` is on, at
  `onApplicationBootstrap` of `NestMcpBootstrap`. `app.useLogger` runs before `init`/`listen` in any
  normal bootstrap, so the active logger at that point is the final one. It is read from `Logger`
  (`@nestjs/common`): the static reference `overrideLogger` stores (`staticInstanceRef`, protected;
  read by index access and documented as a dependency on a Nest detail stable since v7). If none, a new
  `ConsoleLogger` is wrapped. Reinstalled with `Logger.overrideLogger(tee)`. Idempotent: an active
  `LogTee` is never wrapped twice.
- **What is captured**: `log`, `error`, `warn`, `debug`, `verbose` and `fatal` (Nest 10+). Nest's
  signature is `(message, ...optionalParams)` where the last parameter is usually the `context`; split
  as `ConsoleLogger` does: a trailing `string` is the context; in `error`, a preceding multi-line
  string is the `stack`.
- **Ring buffer** of `logs.bufferSize` entries, with a growing `seq` to page ("since entry N"). Nothing
  persisted. The buffer is shared by every instance; each instance filters by scope.
- **Scope filter for `forFeature`**: entries whose `context` equals a class name in the instance's
  closure (controllers, providers, injectables). Approximate, documented; `scope: 'app'` in the input
  lifts the filter.
- **What is not seen**: anything the app's logger writes outside Nest's `Logger` (`pino-http`
  request logs, for example). Documented as a limitation; phase 5 covers requests another way.
- **`tools.logs: false`** installs nothing and the `logs_*` tools are not registered.

## Steps

### 1. Tee and buffer

`src/support/ring-buffer.ts`: `RingBuffer<T>(size)` with `push`, `since(seq)`, `last(n)`, `size`.
`src/logs/log-tee.ts`: `class LogTee implements LoggerService` holding the original logger and the
buffer:

```ts
log(message: unknown, ...params: unknown[]) { this.record('log', message, params); this.inner.log?.(message, ...params); }
```

with `record` splitting `context` and `stack` as decided. `setLogLevels` is delegated without
recording. `src/logs/install-log-tee.ts`: `installLogTee(buffer): LogTee`, idempotent.

### 2. Tools

`src/tools/logs.tools.ts`:

| Tool | Input | Output |
|------|-------|--------|
| `logs_tail` | `{ limit?: number (≤500, default 100); level?: 'fatal'\|'error'\|'warn'\|'log'\|'debug'\|'verbose'; minLevel?: idem; context?: string; contains?: string; sinceSeq?: number; scope?: 'instance'\|'app' }` | Ordered entries `{ seq, timestamp, level, context, message, stack? }` and `lastSeq` for the next call |
| `logs_levels` | — | Active levels (if the logger exposes `isLevelEnabled`) and buffer size and occupancy |

`message` is serialised as is when a string; objects through `JSON.stringify` capped at 2000 characters.

### 3. Fixture app, tests and docs

Remove `logger: false` from the harness; `startApp` accepts `logger?: LoggerService` and by default
provides a `MemoryLogger` (records what it receives) to prove the tee forwards. A `LoggingService` in
the fixture writes a `warn` and an `error` with a stack at bootstrap. `test/logs.spec.ts`: the
`MemoryLogger` receives the same entries `logs_tail` returns, in the same order with the same
arguments; filters by level, context and `sinceSeq`; a buffer of size 3 drops the oldest; two instances
share one buffer; the `forFeature` instance filters by scope; `tools.logs: false` registers nothing.
A second small app in the spec with `nestjs-pino` (test devDependency only) shows what goes through
`Logger` is captured and what `pino-http` writes is not, as the doc states. "Logs" section in the README.

## Files

### Created

- `src/support/ring-buffer.ts`, `src/logs/{log-tee.ts,install-log-tee.ts,model.ts}`
- `src/tools/logs.tools.ts`, `test/logs.spec.ts`, `test/support/memory-logger.ts`

### Modified

- `src/nest-mcp.module.ts`, `src/nest-mcp.bootstrap.ts`, `src/tools/app.tools.ts`
- `test/support/start-app.ts`, `test/fixtures/app/**`
- `README.md`

## Verification / definition of done

- [x] `logs.spec.ts` green; the original logger receives exactly what it did before the tee.
- [x] Two instances in one app do not duplicate entries.
- [x] With `nestjs-pino`, `Logger` output is captured and raw `pino-http` output is not, as documented.
- [x] `yarn build`, `lint`, `type-check` green.

## Likely stumbles

- **`bufferLogs: true`** (common in real apps): Nest buffers in `Logger.logBuffer` until
  `useLogger`/`flush`. Entries flushed before the tee is installed are not in the buffer. Acceptable;
  note it.
- **Partial `LoggerService` implementations** (no `debug`/`verbose`): delegate only if the method exists.
- **Nest 10 without `fatal`**: check `typeof inner.fatal === 'function'`.
- **The inspector's own `Logger` lines** (`NestMcp` context) enter the buffer too: correct, but tests
  must expect them.

## Phase closure — two mandatory commits

Commit 1: `feat(nestjs-mcp): capture the app Logger into a ring buffer and expose logs_tail (Phase 4)`.
Commit 2: `chore(nestjs-mcp): close phase 4`. Then, if a host embeds this repo as a submodule, its pointer on the host side.

## Notes for the next session (Phase 5)

- `RingBuffer` and the idempotent `install*` pattern are reused for traces.
- `NestMcpBootstrap` already owns the moment (`onApplicationBootstrap`) when container instances
  exist: phase 5 wraps enhancers there.
