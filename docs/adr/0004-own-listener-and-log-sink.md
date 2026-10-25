# ADR-0004: The inspector listens on its own port, and reads the app's logger through a sink

**Status**: accepted
**Date**: 2026-10-25
**Supersedes**: [ADR-0001](0001-embedded-streamable-http-endpoint.md) (the endpoint as a Nest controller)

## Context

ADR-0001 mounted the MCP endpoint as an ordinary Nest controller inside the host app, so that the host's
global prefix applied and the endpoint could be protected with the app's own guards. Validating the
package against a real host (ticket #11) showed what that costs:

- Every global enhancer of the host runs on every inspector call: an authentication guard did a remote
  lookup per call, an interceptor logged each JSON-RPC body, and in any environment with real
  authentication the agent would simply get 401 unless the host marks the route public, which is host
  code the package cannot write.
- The endpoint inherits the host's prefix, API versioning and middlewares, which forced the
  version-neutral controller and made the URL depend on the host's configuration.
- The `guards` option, the reason for the controller design, was never used in development, and the
  endpoint is off in production by default anyway.

The same validation showed that `logs_tail` captured almost nothing of a host that logs through a
dedicated logger (`PinoLogger`, winston…): the tee only sees what goes through Nest's `Logger`, and the
host's own logger instances are transient or write straight to a stream.

## Decision

1. **The inspector listens on its own HTTP server inside the process**, not as a controller. One
   listener per process, opened by the first enabled instance at `onApplicationBootstrap` and closed
   with the app, `listen: { host: '127.0.0.1', port: 7777 }` by default and configurable. The
   `forRoot` instance answers at `/`; each `forFeature` instance at its own `path`. Nothing of the
   host runs in front of it: no prefix, no versioning, no middlewares, no enhancers. The URL is logged
   at startup; a busy port fails with a clear error naming the option to change. The controller mode
   is removed; with it go `guards` and `localOnly`. Access control is binding to loopback (the default
   host) plus an optional `authorize(req)` callback; listening outside loopback without `authorize`
   logs a warning.
2. **The host can hand its logger's output to the inspector through a sink.** `createLogSink()` returns
   a writable stream plus a `record(entry)` function; the host creates it before its logger, adds it
   to the logger's outputs (pino `multistream`, a winston transport…) and passes it as `logs.sink`.
   The sink normalises pino/bunyan JSON and plain text out of the box; `logs.normalize(record)` maps
   other formats. Nest's `Logger` keeps being captured; `logs.capture: 'nest' | 'sink' | 'both'`
   (`both` by default) and a `source` field on each entry handle hosts that route Nest's `Logger`
   through the same logger.

## Consequences

- The agent's URL is stable and independent of the host (`http://127.0.0.1:7777/`), and inspector
  calls never touch the host's auth, logging or tracing. The inspector no longer needs to exclude its
  own route from request traces.
- One more port per process. Two apps on one machine need different ports (the host's own dev tools
  may already use one, as Nest Devtools does with 8000), which is why the port is configurable and the
  failure is explicit.
- `authorize(req)` is a plain function over the raw request: no `ExecutionContext`, no Nest guards.
  Hosts that want their own auth in front wrap the inspector with a reverse proxy or implement
  `authorize` themselves.
- The log sink is opt-in and needs one line in the host's logger configuration; without it,
  `logs_tail` keeps showing only Nest's `Logger`, as documented.
- This is a breaking change to the options, made before the first published version.

## Alternatives considered

- **Keep the controller and ask hosts to mark the route public**: works only per host, with host
  code, and still runs the host's interceptors and middlewares on every call.
- **Controller by default, listener opt-in**: two transports to maintain and test for a package that is
  off in production; the controller's only advantage (Nest guards) does not justify it.
- **Wrapping logger instances passed in options** (`logs.loggers: [...]`): misses transient loggers such
  as `PinoLogger` (one instance per injection) and anything written directly to a stream.
- **Per-library adapters** (`@jsirp/nestjs-mcp/pino`, `/winston`): more convenient, more surface to
  maintain; the generic sink covers them with one line of host configuration and can grow adapters
  later.
