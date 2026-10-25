# ADR-0006: Runs are recorded by wrapping job and listener methods on their instances

**Status**: accepted
**Date**: 2026-10-25

## Context

When a cron job or an event listener fails, an agent needs what `request_trace` gives for a request:
that it ran, when, for how long, whether it threw, with which error, and what it logged. Neither
peer offers a hook for it. `@nestjs/schedule` and `@nestjs/event-emitter` each call the decorated
method from a closure of their own and swallow the error into a log line (`suppressErrors` aside),
so the emitter, the registry and the timers never see the outcome.

[ADR-0002](0002-request-tracing-by-wrapping-enhancers.md) wraps enhancer methods, which Nest calls
only from its request pipeline. Job and listener methods are ordinary methods of the app's
providers: the app may call them itself, and each peer reads them at a different moment.
`ScheduleExplorer` reads `instance[method]` once, at its `onModuleInit`, and binds it into the
`CronJob`, `setInterval` or `setTimeout` callback for good. `EventSubscribersLoader` reads the
decorator's metadata from `instance[method]` at its `onApplicationBootstrap`, and calls
`instance[method]` again on every emission. Both read the metadata from the function itself.

## Decision

In `configure` of the inspector's module (before any `onModuleInit`), when the `runs` group is on
and the peer and its module are present, the inspector defines, on each long-lived instance whose
prototype has a `@Cron`, `@Interval`, `@Timeout` or `@OnEvent` method, an own property that wraps
that method. The wrapper carries a copy of the original function's metadata, so both peers find the
decorators on it; calls the original with the same `this` and arguments; returns its value (the very
same promise) or throws what it threw; and records a *run* around it in an `AsyncLocalStorage`, so
log lines written inside it carry the run's id.

- **Jobs**: the scheduler captures the wrapper at `onModuleInit`. At `onApplicationBootstrap` of the
  inspector the own property is taken back (or swapped for the listener wrapper below), so a call the
  app makes to the method itself is never recorded as a job run.
- **Listeners**: the inspector also wraps `emit` and `emitAsync` on the emitter, only to open an
  emission context holding the event name. The listener wrapper stays on the instance and records a
  run only when it is called inside an emission whose event the method's declared pattern matches;
  any other call passes through unrecorded.

Wrapping is once per app and per method (marked), and is skipped entirely with the `runs` group off
or without the peer.

## Consequences

- The app's code does not change, and a failing job or listener leaves a run with its error even
  though the peer swallowed it.
- The inspector defines properties on the app's providers: an own, non-enumerable property per
  wrapped method, holding a function with the original's metadata. Code that inspects own
  properties of a provider instance can see it. The suite guards that both peers still schedule
  and subscribe through it and that emitters return and reject exactly as before.
- `REQUEST`-scoped listeners have no long-lived instance (the loader resolves one per emission);
  their runs are not recorded. Jobs the app adds to `SchedulerRegistry` at runtime are its own
  callbacks; they are not recorded either.
- The line a peer logs after the method threw is written outside the run (the peer's catch is
  outside the wrapper), so it does not carry the run id; the run carries the error itself.
- A change in when either peer reads the method is a breaking risk, which the suite catches by
  firing real jobs and real emissions on every supported Nest major.

## Alternatives considered

- **Wrapping the prototype method**: one place per class, but every call of the method, the app's
  own included, would count as a run, and request-scoped instances share it with no way to tell.
- **Wrapping after the peers registered** (in a lifecycle hook): the scheduler's callbacks already
  hold the original by then; only the listeners would be recorded.
- **Wrapping `SchedulerOrchestrator`'s `add*` methods or the emitter's listeners**: private classes
  and anonymous closures that change between peer versions, and the closures carry no class or
  method to report.
