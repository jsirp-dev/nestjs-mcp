# Plans — `@jsirp/nestjs-mcp`

Index of development phases. The master plan is [`00-overview.md`](./00-overview.md). Each phase has
its own document with fixed sections: objective, prerequisites, closed decisions, steps, files,
verification, likely stumbles and the two-commit closure.

## How to use this folder

1. [`../../CLAUDE.md`](../../CLAUDE.md) first: the full reading order and what not to do.
2. [`00-overview.md`](./00-overview.md): the master plan.
3. [`../../CHANGELOG.md`](../../CHANGELOG.md): which phases are closed and what each one learned.
4. The `phase-NN-*.md` of the phase in progress.

## Conventions

- **Naming**: `phase-NN-{kebab-name}.md` with two digits (`02`, not `2`).
- **Intermediate phases**: letter suffix (`phase-06b-...`), no renumbering.
- **Closure**: two commits, the work and `chore(nestjs-mcp): close phase N`.

## Index

| # | Phase | Status | Document |
|---|-------|--------|----------|
| 1 | Package bootstrap and MCP endpoint | ⚪ Pending | [phase-01-bootstrap.md](./phase-01-bootstrap.md) |
| 2 | Module and provider graph, scope resolution | ⚪ Pending | [phase-02-graph.md](./phase-02-graph.md) |
| 3 | Routes with guards, interceptors, pipes and filters | ⚪ Pending | [phase-03-routes-and-enhancers.md](./phase-03-routes-and-enhancers.md) |
| 4 | Live logs from the app's `Logger` | ⚪ Pending | [phase-04-logs.md](./phase-04-logs.md) |
| 5 | Request traces | ⚪ Pending | [phase-05-request-traces.md](./phase-05-request-traces.md) |
| 6 | Events, listeners and scheduled jobs | ⚪ Pending | [phase-06-events-and-schedule.md](./phase-06-events-and-schedule.md) |
| 6b | CI matrix and release workflow | ⚪ Pending | [phase-06b-ci-and-release.md](./phase-06b-ci-and-release.md) |
| 7 | Host validation and first publication | ⚪ Pending | [phase-07-host-validation-and-publish.md](./phase-07-host-validation-and-publish.md) |

Legend: 🟢 closed (both commits on `main`) · 🟡 in progress · ⚪ pending.

## If a closed decision is reversed

Before continuing, audit every phase written so far (`00-overview.md`, each `phase-NN-*.md` that
mentions it, `CLAUDE.md`, the ADRs) and note the pivot in the `CHANGELOG.md` entry of the phase in
progress.

## How to add a phase

1. Create `phase-NN-{name}.md` with the same structure as the others.
2. Add it to this index with ⚪ and to "Phases" in `00-overview.md`.
3. If it is intermediate, adjust "Previous phase" and "Next phase" in its neighbours.
