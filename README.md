# @jsirp/nestjs-mcp

Runtime [MCP](https://modelcontextprotocol.io) server embedded in your NestJS app, for coding agents.

Add one module and your running app exposes an MCP endpoint that tells an agent (Claude Code, Cursor,
any MCP client) what Nest actually built: the module and provider graph, every route with the guards,
interceptors, pipes and filters it goes through, what the app's `Logger` is writing right now, which
enhancers a given request passed through and how long each took, event listeners and scheduled jobs.
Nothing to install on the agent side: it points at a URL of your app.

> Status: **0.1.0 in development**. Phase 1 ships the endpoint and `app_info`; the other tool groups
> land phase by phase (see the table below).

## Install

```bash
npm install --save-dev @jsirp/nestjs-mcp
```

Everything a Nest app already has is a peer dependency: `@nestjs/common` and `@nestjs/core` 10 or 11,
`reflect-metadata`, `rxjs`, and `zod` (3.25+ or 4, the versions the MCP SDK accepts). `@nestjs/event-emitter`
and `@nestjs/schedule` are optional peers: their tools appear only if your app uses them. The only
runtime dependency is `@modelcontextprotocol/sdk`.

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

Then point your client at the endpoint. With a global prefix `api`, that is `/api/_mcp`:

```json
{
  "mcpServers": {
    "my-nest-app": { "type": "http", "url": "http://localhost:3000/api/_mcp" }
  }
}
```

## Options

All optional. `NestMcpModule.forRoot({ ... })`.

| Option | Default | What it does |
|--------|---------|--------------|
| `enabled` | `process.env.NODE_ENV !== 'production'` | The switch. When `false` the module registers nothing. It is a default, not a rule: set it to `true` wherever you want the endpoint and protect it with `guards`. |
| `path` | `'_mcp'` | Route of the endpoint, relative to the app's global prefix and version-neutral under URI versioning. |
| `guards` | `[]` | Nest guards applied to the endpoint, exactly like `@UseGuards`. |
| `localOnly` | `true` | Reject requests that do not come from loopback. |
| `logs.capture` / `logs.bufferSize` | `true` / `2000` | Tee the Nest `Logger` into a ring buffer (phase 4). |
| `requests.trace` / `requests.bufferSize` / `requests.idHeader` | `true` / `500` / `x-nest-mcp-request-id` | Per-request traces through guards, interceptors, pipes and filters (phase 5). |
| `serverInfo.name` / `serverInfo.version` | your app's `package.json` | What the server reports in the MCP `initialize` handshake. |

## Tools

| Group | Tools | Status |
|-------|-------|--------|
| `app` | `app_info`: Nest and Node versions, uptime, global prefix, versioning, endpoint path, available groups | ✅ |
| `graph` | `graph_modules`, `graph_module`, `graph_providers`, `graph_provider`, `graph_cycles` | planned |
| `routes` | `routes_list`, `route_get` (each route with its guards, interceptors, pipes and filters, global → controller → method) | planned |
| `logs` | `logs_tail`, `logs_levels` | planned |
| `requests` | `requests_list`, `request_trace` | planned |
| `events` / `schedule` | `events_listeners`, `events_recent`, `schedule_jobs` | planned |

Every tool returns JSON as a single text block. Errors come back as `{ "error": "<code>", "hint": "…" }`
with `isError: true`.

## How it works

- **Stateless Streamable HTTP.** Each `POST` gets its own MCP server and transport, answered and closed.
  `GET` and `DELETE` return 405: there are no sessions to stream to or tear down.
- **A Nest controller.** The endpoint is a regular controller mounted by the module, so your global
  prefix applies and the `guards` you configure get a real `ExecutionContext`.
- **Nothing leaves the process.** The server runs inside your app; the only network is the agent
  calling your app.

## Security

The endpoint shows the inside of your app. By default it is off in production and only accepts
loopback. If you turn it on elsewhere, put a guard in front of it:

```ts
NestMcpModule.forRoot({ enabled: true, localOnly: false, guards: [MyAuthGuard] });
```

## Limitations

- Verified with Express. Fastify is not verified yet.
- `graph_*` and `routes_*` need `snapshot: true` in `NestFactory.create`; without it they return
  `snapshot_disabled` with the exact option to set.
- The log capture sees what goes through Nest's `Logger`. A logger that writes on its own (for
  example `pino-http` request logs) is not captured.

## License

MIT
