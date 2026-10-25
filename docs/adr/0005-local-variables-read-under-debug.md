# ADR-0005: Under `debug`, the inspector reads the local variables of the frames that threw

**Status**: accepted
**Date**: 2026-10-25
**Refines**: [ADR-0003](0003-inspector-only-never-business-tools.md) (inspector only) and closed
decision 11 of the [master plan](../plans/00-overview.md) (bodies never stored)

## Context

With `debug` on (ticket #25), every error a trace step or a run records carries its stack: where it
failed. An agent still has to guess *why*: which id the handler looked up, what the computed total
was, which branch it took. The values were there at the moment of the throw, in the scopes of the
frames on the stack, and they are gone by the time the error reaches a step.

Reading them is unlike anything else the package does. Everything so far observes what Nest built
and the shape of what the app does (names, timings, outcomes, positions) and never the app's data:
traces keep the URL and, per option, the headers, never a body. Local variables are the app's data:
a request body, a user record, a token in a variable all show up in them. And the only way to read
them in a running process is the V8 inspector protocol, the same one a debugger uses, which can also
run code in the app, set breakpoints and change variables.

Two constraints shape the mechanism. A `node:inspector` session connected in the main thread cannot
pause that thread: the throw has to stop the main thread while something else reads its frames, so
the session lives in a worker thread, connected with `connectToMainThread()`. And the protocol has no
way to tell which request a paused frame belongs to without running code in the app (the
`AsyncLocalStorage` that holds the trace is not readable from a paused frame), so the capture has to
be paired with the error after the throw, on the main thread.

## Decision

The inspector may read the values of local variables when, and only when, `debug` is on and its
`locals` part has not been switched off. Read, never evaluated:

- **A worker thread holds the only inspector session**, created on the first install of a `debug`
  with locals and terminated on the last release. With `debug` off (the default) no session and no
  worker exist. The session enables the debugger with breakpoints inactive (so a `debugger`
  statement in the app does not stop it) and pauses on every exception, caught or not.
- **Nothing in the session runs code in the app**: no `Runtime.evaluate`, no `callFunctionOn`, no
  breakpoints set by the inspector or by a tool, no variable changed. It reads with
  `Runtime.getProperties` (own properties only), which does not call getters, and resumes. No tool
  reaches the session: locals are recorded at the throw and served from the trace like the rest of
  it.
- **The worker filters before it reads**, on data it already has: it resumes at once when no trace
  or run is in flight (a counter the main thread keeps in shared memory), when the exception is not
  an `Error`, when the frame that threw is not the app's (`node_modules`, `node:` internals, code
  without a file, this package's own files), when it is the app rethrowing, from a `catch` block,
  the exception it caught, and beyond the rate limit.
- **What it reads** is the `local` scopes (block and `catch` scopes included) and the `closure`
  scopes of the top frames, never `script`, `module` or `global`. Values become a bounded preview:
  primitives, plain objects and arrays a few levels deep, own data properties only. An accessor is
  shown as `[Getter]` without being called; a function by its name, never its source; a class
  instance with its constructor's name; a `Map`, `Set`, `Date`, `Promise`, proxy and the like by
  their description, without entering them.
- **Bounded**, with options under `debug.locals` and these defaults: 5 frames, 2 levels of objects,
  20 properties per object (and variables per scope), 200 characters per string, 16 KB per error,
  10 captures per minute. Beyond the rate the error says `localsSkipped: 'rate'` and nothing is read.
- **Pairing**: the worker posts each capture, before it resumes, keyed by the exception's stack text
  (which the inspector reports with the pause); the main thread drains them synchronously when it
  describes an error, takes the one whose key is the error's `stack`, and keeps it with that error
  object. When two pending captures share a key (the same code failing in two requests at once) it
  takes neither, with `localsSkipped: 'ambiguous'`: missing locals rather than another request's.
  Captures nobody claims expire after a few seconds.
- **Where they appear**: `locals` sits next to `stack` on the error, aligned with it. Requests and
  runs both get them, because both open the window the worker checks: a failing cron is as worth
  understanding as a failing request. Exceptions thrown with nothing in flight (startup, a timer the
  app set) are never read.

## Consequences

- An agent sees `total: 42` next to the line that threw. It can also see whatever else was in scope:
  a password in a local, a body the handler parsed, a token in a closure. The README says so, and
  that `debug` is meant for development; `authorize` and `enabled` protect it like the rest.
- "Bodies never" now has one exception: what is in a local variable at a throw, under `debug`,
  bounded. Headers and bodies the request carries are still never stored.
- The main thread stops at every exception while `debug` with locals is on: for the time the worker
  takes to filter (no read) or to read a capture (bounded by the limits). The CHANGELOG reports the
  measured cost; it is a development tool, not something to leave on under load.
- While locals are on, the inspector's session is one more debugger attached to the process. A
  developer's own debugger keeps working, but pauses on exceptions that it did not ask for are
  resumed by the worker, and one it asked for ("pause on caught exceptions") may be resumed too.
  Turning `debug.locals` off restores a plain process.
- Exceptions the app's own code throws and catches during a request count against the rate, read or
  not; the frame that rethrows from a `catch` block does not. Locals of an exception rethrown in
  other ways (a promise's `catch` handler that throws again) are the rethrow site's.
- The capture is only as good as the key: an `Error` whose `stack` the app replaced after the throw
  matches nothing and gets no locals.

## Alternatives considered

- **A session on the main thread**: simpler, but it can only read while something else pauses the
  thread; it cannot stop at a throw.
- **Correlating by request id read from the paused frame**: the trace lives in an
  `AsyncLocalStorage` that only running code can read; reading it means `Runtime.evaluate`, which is
  exactly what this ADR rules out.
- **Marking errors or installing `Error.prepareStackTrace`** to give each exception an identity:
  alters what the app's own errors and stacks look like (ticket #25 refused the same hook for stacks).
- **Locals only on request traces**: crons and listeners fail too, and excluding them would leave the
  window open anyway whenever a request is in flight at the same time.
- **Pausing only on uncaught exceptions**: Nest catches every handler's exception, so nothing in a
  request would ever pause.
