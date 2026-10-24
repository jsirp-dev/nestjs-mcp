# ADR-0002: Request traces are recorded by wrapping enhancer instances at bootstrap

**Status**: accepted
**Date**: 2026-10-25

## Context

The most valuable question an agent asks when debugging a 403 or a 500 is "which guards, interceptors,
pipes and filters did this request actually go through, in which order, and where did it stop?". Nest
offers no hook that observes the whole enhancer chain: a global interceptor sees only the handler, and
the guards that run before it are invisible to it. The chain is only observable from inside each
enhancer.

## Decision

At `onApplicationBootstrap` the inspector walks the container (`ModulesContainer` and
`ApplicationConfig`) and wraps, in place, the `canActivate`, `intercept`, `transform` and `catch`
methods of every enhancer instance it finds, global and per route. Each wrapper records a step (kind,
name, outcome, duration) into the trace held in an `AsyncLocalStorage` that a middleware opens per
request, then calls the original with the same `this` and arguments and returns its result untouched.
Wrapping is idempotent (instances are marked) and is skipped entirely when the `requests` tool group is
off.

## Consequences

- The app's code does not change, yet the trace shows the real chain, including global enhancers and
  the one that denied the request.
- The inspector modifies objects of the host app at startup. The wrappers must be transparent: same
  return value, same exceptions, same `this`, Observables and Promises passed through. The suite
  guards this.
- `REQUEST` and `TRANSIENT` scoped enhancers have no long-lived instance to wrap; they are reported as
  not traced.
- Any future Nest change in how enhancer instances live in the container is a breaking risk, which is
  why the CI matrix runs the suite on every supported Nest major.

## Alternatives considered

- **A global `APP_INTERCEPTOR` only**: no mutation of app objects, but it records controller, handler,
  status and timing and nothing about guards, pipes or filters, which is the point.
- **Patching Nest's router execution context** (`RouterExecutionContext`, `GuardsConsumer`): sees
  everything from one place, but depends on private classes that change between Nest versions far
  more than the public enhancer interfaces do.
- **Asking the app to decorate its enhancers**: observable and explicit, but it changes the app's code
  and misses every enhancer the owner forgets.
