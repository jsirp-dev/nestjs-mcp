# `@jsirp/nestjs-mcp` — entry point for any session

A NestJS module that embeds, in the app itself, an MCP server (Streamable HTTP, stateless) with runtime
inspection tools for coding agents: the module and provider graph, routes with their guards,
interceptors, pipes and filters, what Nest's `Logger` writes, per-request traces, event listeners and
scheduled jobs. It is a **publishable, framework-agnostic package**: it knows nothing about the app it
is mounted in. It may be developed inside a host monorepo (as a git submodule, to try it against real
apps before publishing), but nothing from that host enters this repository: no imports, no domain
vocabulary, no names.

The living plan is in [`docs/plans/`](docs/plans/). Start there.

## Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript 5, ESM + CJS via `tsup` |
| Framework | NestJS module; peer `@nestjs/common` and `@nestjs/core` `>=10 <12`; `ConfigurableModuleBuilder` for `forRoot`/`forRootAsync`/`forFeature`/`forFeatureAsync` |
| Protocol | `@modelcontextprotocol/sdk` ^1.32, embedded Streamable HTTP transport |
| Validation | `zod` (peer, the range the SDK accepts) |
| Optional peers | `@nestjs/event-emitter`, `@nestjs/schedule` |
| Tests | jest + ts-jest, fixture app under `test/fixtures`, the real SDK MCP client |
| CI | GitHub Actions: Nest 10/11 × Node 20/22 matrix; release on tag |
| Node | `>=20` (`.nvmrc`) |

## Mandatory reading order

1. **This file.**
2. [`docs/plans/00-overview.md`](docs/plans/00-overview.md): master plan, promised public API, closed
   and open decisions.
3. [`GLOSSARY.md`](GLOSSARY.md) and the ADRs in [`docs/adr/`](docs/adr/) that touch your area.
4. [`CHANGELOG.md`](CHANGELOG.md): closed phases and what each one learned.
5. The `docs/plans/phase-NN-*.md` of your phase.

If this checkout lives inside a host monorepo, that host has its own `CLAUDE.md` with its own rules
(commits, hooks, documentation); they apply to the host's files, not to the contents of this repo.

## Conventions

- **Commits in English**, `type(scope): description`; scope `nestjs-mcp`. Never mention Claude or add
  `Co-Authored-By`.
- **Phase closure in two commits**: the work (without `CHANGELOG.md`), then `CHANGELOG.md` alone with
  `chore(nestjs-mcp): close phase N`. Without both, the phase is not closed.
- **Sessions commit on their own in this repo** (branch `main`): once the phase's verification boxes
  are ticked, make the commits yourself, with the message shown in the phase document. Do not push
  unless the brief asks for it. A host monorepo that embeds this repo as a submodule commits its pointer
  on its side, and that one is never yours to make.
- **Every acceptance criterion is checked with a command** whose output you can paste.
- **Everything in English**: code, identifiers, error messages, docs, plan, logbook, glossary, ADRs.
- **Use the glossary's vocabulary** (`GLOSSARY.md`): *inspector*, *instance*, *scope*, *tool*, *tool
  group*, *trace*, *step*, *enhancer*. Do not drift to synonyms the glossary avoids.

## What you should NOT do

- ❌ Import anything that is not declared in `package.json`, or name the host app or monorepo anywhere
  in this repo. The lint rule `import/no-extraneous-dependencies` blocks the first; if the second
  tempts you, the example belongs to the host's own docs.
- ❌ Assume a logger, an RPC layer, a database or Fastify. Express is verified; Fastify is unsupported
  in v1.
- ❌ Expose business logic as tools, or open the tool registry to the host app. The package is an
  inspector ([ADR-0003](docs/adr/0003-inspector-only-never-business-tools.md)).
- ❌ Constructor injection without an explicit `@Inject(token)` in `src/`: the build is esbuild (tsup)
  and does **not** emit `design:paramtypes`; without the token, Nest cannot inject in the published
  build (ts-jest tests do emit metadata, so they will not catch it).
- ❌ `instanceof` with Nest classes: a host may run two Nest majors side by side and the classes
  differ. Duck typing.
- ❌ Read `process.env` beyond the default of `enabled`. Everything else arrives through the options.
- ❌ Store request bodies or event payloads in buffers. Full URL and, per option, headers; never bodies.
- ❌ Mask, filter or alter what the app logs. The tee is transparent.
- ❌ Reopen closed decisions of `00-overview.md`. If one does not work, pick the closest alternative
  and record it under "Hot decisions" in the CHANGELOG.
- ❌ Do another phase's work in yours, or opportunistic cleanups. Note what you see under "Notes for
  the next session".
- ❌ Publish to npm from a session. `npm pack --dry-run` yes; the release runs from GitHub Actions on a
  tag the person creates.

## Local setup

```bash
# Standalone (Node from .nvmrc, yarn from packageManager):
yarn install && yarn build && yarn test
yarn lint && yarn type-check

# Inside a host monorepo that lists this folder as a workspace, run the same scripts through the
# host's package manager (its lockfile rules there).
```

The pre-commit hook (`.husky/pre-commit`) only checks, never writes: `format-check`, `lint`,
`type-check`, `build`.

To try it against a real app: mount it in any Nest app with `snapshot: true` (README, Quick start).

## How to start the next phase

1. `git log` and `CHANGELOG.md` say which phase closed last (two commits).
2. Open the next `docs/plans/phase-NN-*.md` and update its status in `docs/plans/README.md`.
3. Start the session with the method's brief (reading order, objective, what not to do, deliverable,
   two-commit closure). Only when the person asks for a separate session; otherwise, work here.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `jsirp-dev/nestjs-mcp`, through the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, unrenamed: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root + `docs/adr/`. See `docs/agents/domain.md`.
