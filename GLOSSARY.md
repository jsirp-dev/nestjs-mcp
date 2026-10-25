# Glossary

The vocabulary of `@jsirp/nestjs-mcp`. Use these terms in code, tests, docs, issues and commits; avoid
the synonyms each entry lists.

**Inspector**:
The MCP server this package embeds in a running NestJS app so a coding agent can see what Nest built
and what the app is doing. It observes; it never exposes the app's business logic.
_Avoid_: devtools server, debugger, MCP for the app

**Instance**:
One mounted inspector, created by one `forRoot` or `forFeature` call: its own endpoint, scope,
`authorize` and switches. An app may run several, all on the same listener.
_Avoid_: server (ambiguous with the MCP server the SDK creates per request)

**Scope**:
The boundary an instance observes. Either the whole app (`forRoot`) or a module closure (`forFeature`):
that module and everything it imports, transitively. Every tool answers within the instance's scope.
_Avoid_: context (Nest and MCP both use it for other things), area, slice

**Listener**:
The HTTP server the inspector opens inside the app's process (`127.0.0.1:7777` by default), shared by
every instance of that app (one per process when the process runs one Nest app) and independent of
the app's own HTTP server: no host prefix,
versioning, middleware or enhancer runs on it.
_Avoid_: devtools port, admin port, the app's server

**Endpoint**:
The route on the listener where an instance answers MCP requests: `/` for the app instance, the
configured `path` for a module instance.
_Avoid_: URL (that is the absolute address), transport (the protocol layer behind it)

**Log sink**:
The writable the host attaches to its own logger (pino, winston…) so the inspector receives that
logger's lines next to Nest's `Logger`; created with `createLogSink()` and passed as `logs.sink`.
_Avoid_: transport (pino and winston use it for the same idea; here it names the protocol layer), appender

**Tool**:
One capability the inspector offers to the agent, named `snake_case` with its group as prefix, taking
a validated input and answering JSON.
_Avoid_: command, action, endpoint

**Tool group**:
The tools that share a prefix and a switch: `app`, `graph`, `routes`, `logs`, `requests`, `events`,
`schedule`.
_Avoid_: feature, module (reserved for Nest modules)

**Enhancer**:
Nest's own term for a guard, interceptor, pipe or exception filter: the things that run around a
handler. Used here exactly as Nest uses it.
_Avoid_: middleware (a different Nest concept, reported separately), decorator

**Trace**:
What the inspector records about one request: method, full URL, status, timing, the handler, and the
ordered steps it went through.
_Avoid_: log (the Logger output is a different thing), span, request history

**Step**:
One recorded unit inside a trace: an enhancer, the handler, or an exception filter, with its outcome
and duration.
_Avoid_: event, hop, stage

**Snapshot**:
Nest's `snapshot: true` option in `NestFactory.create`, which makes Nest keep the serialized graph the
inspector reads. Without it there is no graph, no routes and no scope resolution.
_Avoid_: devtools mode, inspector mode

**Correlation header**:
The request header (`x-nest-mcp-request-id` by default) an agent sets on a request so it can ask for
that request's trace afterwards. Read, never echoed back.
_Avoid_: request id (that is the value; this is the header carrying it)
