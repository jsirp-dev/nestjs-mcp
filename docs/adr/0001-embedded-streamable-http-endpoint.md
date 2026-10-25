# ADR-0001: The inspector is an endpoint embedded in the app, not a separate process

**Status**: superseded by [ADR-0004](0004-own-listener-and-log-sink.md) (the endpoint is no longer a Nest controller; the inspector listens on its own port)
**Date**: 2026-10-25

## Context

An MCP server can run as its own process that the agent spawns (stdio) or as an HTTP endpoint the agent
connects to. The existing Nest option, `nestjs-devtools-mcp`, is a stdio bridge: a preload hook injects
endpoints into the app and a separate process proxies the agent to them. We need the inspector to see the
inside of the running app (the container, the serialized graph, the Logger, the enhancer instances),
which only code running inside the app can do, and we want the agent to need no installation of its
own.

## Decision

The inspector is a NestJS module that mounts a Streamable HTTP endpoint inside the app, as an ordinary
controller under the app's global prefix. It is stateless: each `POST` gets its own MCP server and
transport, answered and closed. The client points at a URL of the app; nothing runs on the agent's
side. No stdio bridge ships in v1.

## Consequences

- The app owner adds one module and, for the graph, `snapshot: true`. The agent adds one URL.
- Being a controller, the endpoint is protected by ordinary Nest guards with an `ExecutionContext`,
  and the global prefix and versioning apply as they would to any route.
- Stateless means no server-initiated notifications and no sessions; `GET` and `DELETE` answer 405.
  Every tool is request/response, which is what the inspection needs.
- Clients that only speak stdio cannot connect until a bridge exists. Claude Code and Cursor speak
  HTTP today.
- The endpoint shows the inside of the app, so it ships off in production by default, loopback-only
  by default, and with configurable guards for anything else.

## Alternatives considered

- **stdio process with a preload hook** (what `nestjs-devtools-mcp` does): no app change, but the
  process only sees what the hook exposes over HTTP anyway, needs installing per agent, and cannot be
  protected with the app's own guards.
- **Sessionful Streamable HTTP**: enables notifications, at the cost of session state inside the app
  and reconnection handling for nothing the inspection tools need.
