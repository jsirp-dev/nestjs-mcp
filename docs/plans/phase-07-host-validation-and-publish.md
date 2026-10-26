# Phase 7 — Host validation and first publication

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-06b-ci-and-release.md`](./phase-06b-ci-and-release.md)

> **Superseded in part by [ADR-0004](../adr/0004-own-listener-and-log-sink.md)** (decided after the
> first host validation): the inspector has its own listener (`http://127.0.0.1:7777/` by default), so
> `guards`, `localOnly`, the `/api/_mcp` route and the "endpoint answers 404" check below no longer
> apply. The host validation ran twice (ticket #11); its findings were tickets #13 to #22 and #29 to
> #30, all closed before the release.

## Objective

The package is mounted in a **real host application**, outside the fixture, on both supported Nest
majors, and every tool group is exercised while that app does real work: requests through its own auth
guards and interceptors, its logs, its domain events, its scheduled jobs. What the host sees that the
fixture never showed becomes issues in this tracker. Then the package gets its first release (`v0.1.0`)
from the release workflow and its listing in the official MCP Registry. The host is one consumer among
others; nothing in the package changes for it, and nothing about it is recorded here beyond "a Nest 10
host" and "a Nest 11 host".

At the end: with the host up and the instance enabled, `claude mcp list` shows it connected;
`routes_list` returns the host's routes with their guards; `request_trace` of a real request goes through
the host's auth guard and interceptors; every finding is an issue; `@jsirp/nestjs-mcp@0.1.0` is on npm
with provenance.

## Prerequisites

- [x] Phase 6b closed; `ci.yml` green on `main`.
- [x] A host app on Nest 11 and one on Nest 10 available locally, with the person who runs them.
- [x] `NPM_TOKEN` secret in the GitHub repo.

## Closed decisions for this phase

- **The host decides how it enables the instance** (its own environment layer, its own switch); the
  package only documents `enabled`, `path`, `guards` and `localOnly`. `forRootAsync` with the host's
  configuration service is the expected shape.
- **Findings go to the tracker, not into this phase**: a gap or bug seen on the host is filed as its own
  issue with the `needs-triage` label and fixed in a corrective phase, never patched here.
- **The host's own documentation and wiring** (how it mounts the module, where its endpoints are listed
  for MCP clients) live in the host's repository and are not described here.
- **Release**: the person runs `npm version 0.1.0` and pushes the tag; `release.yml` publishes. Then
  the MCP Registry listing (`mcp-publisher` CLI, npm ownership proof through the package's `mcpName`
  field).

## Steps

### 1. Mount in the hosts

Following the README's Quick start: `NestMcpModule.forRoot` or `forRootAsync` in each host's root
module, `snapshot: true` in its `NestFactory.create`, the instance enabled in development only. Check
the `NestMcp` log line with the URL on both hosts.

### 2. Point an MCP client at them

An `http` entry per host in the client's configuration (Claude Code's `.mcp.json`, for example).
`claude mcp list` shows them connected; with a host down, the entry reports not connected and breaks
nothing else.

### 3. Exercise every tool group while the host works

With the host up, perform real operations through its own UI or API, then ask the inspector:
`graph_modules` and `graph_module` for the host's modules; `routes_list` and `route_get` for its routes
and their guards; `logs_tail` while the operation runs; `request_trace` of each request, with the
correlation header set by the client; `events_listeners` and `events_recent` for the domain events the
operation emits; `schedule_jobs` for the host's jobs. Repeat on the Nest 10 host. Anything that does
not show as expected (routes registered through an RPC layer, guards from a third-party authorization
library, global interceptors, logs written outside Nest's `Logger`, enhancers on scoped providers)
becomes an issue with the exact repro, labelled `needs-triage`.

### 4. Release

- `README.md` final; `CHANGELOG.md` gets a `## 0.1.0` release-notes section above the logbook.
- `npm pack --dry-run` lists only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`.
- Commands for the person, each in its own block: `npm version 0.1.0`, `git push --follow-tags`, then
  the MCP Registry publication once npm shows the version.

## Files

### Modified

- `README.md`, `CHANGELOG.md`, `package.json` (`version`, `mcpName`)

Nothing in `src/` changes in this phase; fixes go through issues and corrective phases.

## Verification / definition of done

- [ ] Both hosts log the endpoint URL when enabled; disabled, the endpoint answers 404 and the host
      is unchanged.
- [ ] `claude mcp list` shows both instances connected with the hosts up.
- [ ] `routes_list` on each host includes routes with guards; `request_trace` of a real request shows
      guard → interceptors → handler → status; `logs_tail`, `events_*` and `schedule_jobs` answer with
      the host's real data or a documented reason why not.
- [x] Every discrepancy is an issue in the tracker with a repro.
- [x] `npm pack --dry-run` lists only the expected files.
- [x] `@jsirp/nestjs-mcp@0.1.0` published with provenance; listed in the MCP Registry.
- [x] Open decisions 1 to 3 of the master plan closed or consciously parked for v1.x.

## Likely stumbles

- **Two Nest majors in one host monorepo**: if the package resolves `@nestjs/core` from a hoisted copy
  while a host app uses its own nested copy, injection tokens (`ApplicationConfig`, `SerializedGraph`)
  are different classes and the module cannot resolve them. The host must make the package resolve the
  app's own Nest (a nested install or a resolution override); the package uses duck typing only
  (`git grep instanceof src` must be empty) but cannot fix token identity.
- **`bufferLogs: true`** in a host: the first lines are not in `logs_tail` (phase 4).
- **Global prefix and URI versioning**: the endpoint is `VERSION_NEUTRAL`, so with prefix `api` it lands
  at `/api/_mcp`, not `/api/v1/_mcp`. If it shows under a version, the controller version option did
  not apply.
- **A development proxy in front of the host** may not forward the endpoint: point the client straight
  at the app.

## Phase closure — two mandatory commits

Commit 1: `chore(nestjs-mcp): prepare the 0.1.0 release after host validation (Phase 7)` with the
README and release notes; then the tag. Commit 2: `chore(nestjs-mcp): close phase 7`. The person
launches them.

## Notes for the next session

- Project closed on completion. Leftovers ("retrospective insight", debts) go to a final
  `CHANGELOG.md` entry "Project closed" and to issues.
