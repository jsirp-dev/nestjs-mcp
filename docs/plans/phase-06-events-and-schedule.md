# Phase 6 — Events, listeners and scheduled jobs

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-05-request-traces.md`](./phase-05-request-traces.md)
> Next phase: [`phase-06b-ci-and-release.md`](./phase-06b-ci-and-release.md)

## Objective

The agent knows who listens to each event (`@OnEvent` from `@nestjs/event-emitter`), which events were
emitted recently and with how many listeners, and which cron jobs, intervals and timeouts are
registered (`@nestjs/schedule`), with expression and next run. Both libraries are optional peers: if
the app does not have them, these tools do not exist and `app_info.tools` says so.

At the end: on the fixture app, `events_listeners()` lists `CatsService.onCatAdopted` for
`cat.adopted`, `events_recent()` shows one emission with `listeners: 1`, and `schedule_jobs()` lists
the cron `cleanup` with its expression and `nextRun`.

## Prerequisites

- [x] Phase 5 closed.
- [x] `forEachInstance` in `support/` (phase 5 note). Created in #8 and used by the events walk;
      `wrap-enhancers.ts` keeps its own loop (moving it is a cleanup outside this phase).

## Closed decisions for this phase

- **Detection by guarded `require`** in `src/support/optional-peer.ts`:
  `tryRequire('@nestjs/event-emitter')` and `tryRequire('@nestjs/schedule')`. If the package is
  missing or the app does not import its module (no `EventEmitter2` or `SchedulerRegistry` in the
  container), the group is not registered.
- **Listeners by metadata**: `@OnEvent` leaves `EVENT_LISTENER_METADATA` (exported by the package) on
  the method with `{ event, options }`. Walk the container with `forEachInstance` and `MetadataScanner`
  over the prototype. Nothing of the app is called.
- **Recent events by wrapping `EventEmitter2.emit` and `emitAsync`** on the container instance
  (idempotent, like the enhancers): `{ event, timestamp, listeners: emitter.listenerCount(event) }`
  into a ring buffer. **No payload.** If this proves fragile across emitter versions, keep
  `events_listeners` only and record the decision in the logbook.
- **Schedule through `SchedulerRegistry`**: `getCronJobs()`, `getIntervals()`, `getTimeouts()`; for
  the expression and the method, the `SCHEDULE_CRON_OPTIONS` / `SCHEDULER_NAME` metadata of decorated
  methods. `nextRun` from `CronJob.nextDate()` when available.
- **Scope**: listeners and jobs declared by classes in scope; emissions are process-wide (an event has
  no module), reported as such.

## Steps

### 1. Optional peers

`src/support/optional-peer.ts`; `app_info.tools.events` and `.schedule` become real.

### 2. Events

`src/events/listeners-reader.ts` → `{ event: string | string[]; className; methodName; options }[]`.
`src/events/emit-recorder.ts` → `installEmitRecorder(emitter, buffer)`.
`src/tools/events.tools.ts`:

| Tool | Input | Output |
|------|-------|--------|
| `events_listeners` | `{ event?: string }` | Matching listeners (substring or the emitter's wildcard) |
| `events_recent` | `{ limit?: number; event?: string }` | Latest emissions with `listeners` |

### 3. Schedule

`src/schedule/jobs-reader.ts` → `{ kind: 'cron' | 'interval' | 'timeout'; name; className?; methodName?;
expression?; everyMs?; running?: boolean; lastRun?; nextRun? }[]`. `src/tools/schedule.tools.ts` with
`schedule_jobs({ kind? })`.

### 4. Fixture app, tests and docs

Add `EventEmitterModule.forRoot()`, an `@OnEvent('cat.adopted')` and `ScheduleModule.forRoot()` with a
`@Cron('0 3 * * *', { name: 'cleanup' })` to the fixture; both packages as devDependencies.
`test/events.spec.ts` and `test/schedule.spec.ts`; a third spec boots an app without those modules and
checks `tools/list` has no `events_*` or `schedule_*`. Sections in the README.

## Files

### Created

- `src/support/{optional-peer.ts,for-each-instance.ts}` (if missing)
- `src/events/{listeners-reader.ts,emit-recorder.ts,model.ts}`, `src/schedule/{jobs-reader.ts,model.ts}`
- `src/tools/{events.tools.ts,schedule.tools.ts}`
- `test/{events.spec.ts,schedule.spec.ts,without-peers.spec.ts}`

### Modified

- `package.json` (devDependencies), `src/nest-mcp.module.ts`, `src/tools/app.tools.ts`,
  `test/fixtures/app/**`, `README.md`

## Verification / definition of done

- [x] The three specs green. #8: `events.spec.ts` and `without-peers.spec.ts` green; #9:
      `schedule.spec.ts` (12) and the schedule half of `without-peers.spec.ts` green.
- [x] Without the peers (simulate with `jest.mock` making `tryRequire` return `null`), the module boots
      and registers nothing of the group. #8: events (`jest.mock('@nestjs/event-emitter')` throws,
      so `tryRequire` returns `null`, with a look-alike `EventEmitter2` provider in the app); #9:
      schedule, the same way with a look-alike `SchedulerRegistry` (a control run without the mock
      lists `schedule_jobs`).
- [x] Wrapped `emit` returns exactly what it returned (boolean) and `emitAsync` the same promise.
- [x] `yarn build`, `lint`, `type-check` green. Green at #8's commit and at #9's.

## Likely stumbles

- **Emitter versions**: `@nestjs/event-emitter` 2 and 3 export `EVENT_LISTENER_METADATA`; wildcards
  (`cat.*`) depend on `wildcard: true` in `forRoot`. Match with `emitter.listeners(event)` rather than
  string comparison when wildcards are on.
- **`@nestjs/schedule` 4 vs 5/6**: cron metadata names changed (`SCHEDULE_CRON_OPTIONS` stays,
  `SCHEDULER_NAME` came later). Read both tolerantly.
- **`CronJob.nextDate()`** returns a luxon `DateTime` in `cron` 3: `toISO()` if present, else
  `toString()`.
- **Listeners on `REQUEST` providers** have no container instance; list them from the class metadata
  anyway (it lives on the prototype).

## Phase closure — two mandatory commits

Commit 1: `feat(nestjs-mcp): list event listeners, recent emissions and scheduled jobs (Phase 6)`.
Commit 2: `chore(nestjs-mcp): close phase 6`. Then, if a host embeds this repo as a submodule, its pointer on the host side.

## Notes for the next session (Phase 6b)

- The package is feature-complete for v1. Phase 6b adds the CI matrix and the release workflow before
  the host validation; it changes no `src/`.
