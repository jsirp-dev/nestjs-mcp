# Phase 2 — Module and provider graph, scope resolution

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-01-bootstrap.md`](./phase-01-bootstrap.md)
> Next phase: [`phase-03-routes-and-enhancers.md`](./phase-03-routes-and-enhancers.md)

## Objective

The agent can ask which modules exist, what each imports and exports, which providers and controllers
it holds, what each provider depends on and who depends on it, and whether there are cycles. All from
the `SerializedGraph` Nest builds with `snapshot: true`, never from source. The same reader resolves
the **scope** of each instance: `forRoot` sees everything; `forFeature` sees the closure of the module
that imported it.

At the end: on the fixture app, `graph_module({ name: 'CatsModule' })` returns its imports, providers,
controllers and exports; `graph_provider({ token: 'CatsService' })` says it depends on `OwnersService`
and is injected by `CatsController`; the `forFeature` instance mounted in `CatsModule` reports
`scope: { kind: 'module', module: 'CatsModule' }` and its `graph_modules` lists only `CatsModule` and
`OwnersModule`.

## Prerequisites

- [x] Phase 1 closed (two commits on `main`).
- [ ] `yarn test` green at start.

## Closed decisions for this phase

- **Single source: `SerializedGraph`** (`@nestjs/core/inspector`), injected as
  `@nestjs/devtools-integration` does. `toJSON()` is read per call (cheap) and mapped to the package's
  own model in `src/graph/model.ts`, so nothing else depends on Nest's internal shape.
- **Scope resolution**: the instance's own dynamic module is a node in the graph; the module that
  imports it is found through the `module-to-module` edges pointing at it. The closure is that module
  plus everything reachable through its imports, excluding Nest's internal modules. Resolved once, at
  the first call that needs it (the graph exists only after `app.init()`); `app_info.scope` reports it.
- **Without `snapshot`, a useful error**: every graph tool answers
  `{ error: 'snapshot_disabled', hint: 'Pass { snapshot: true } to NestFactory.create' }` with
  `isError: true`; a `forFeature` instance reports `scope_unresolved` and every tool falls back to app
  scope, saying so in the answer's `scope` field.
- **Tokens as text**: class tokens by `name`; `symbol` and `string` tokens by description. Instances
  are never returned.
- **Nest's internal nodes** (`metadata.internal === true`, `InternalCoreModule`) are hidden by default;
  `includeInternal: true` shows them.

## Steps

### 1. Graph reader and scope

`src/graph/graph-reader.ts`: `GraphReader` with `read(): GraphModel | GraphUnavailable`. `GraphModel`:

```ts
type GraphModel = {
  modules: Record<string, { id: string; name: string; global: boolean; dynamic: boolean;
    imports: string[]; exports: string[]; providers: string[]; controllers: string[] }>;
  classes: Record<string, { id: string; name: string; kind: 'provider' | 'controller' | 'injectable' | 'middleware';
    module: string; scope: 'DEFAULT' | 'REQUEST' | 'TRANSIENT'; durable: boolean; exported: boolean;
    token: string; initTimeMs: number; subtype?: string; global?: boolean;
    enhancers?: Array<{ name: string; subtype: string; methodKey?: string }> }>;
  edges: Array<{ from: string; to: string; kind: 'module-to-module' | 'class-to-class'; key?: string }>;
};
```

`src/instance/scope.ts`: `resolveScope(graph, instanceModuleToken)` → `{ kind: 'app' }` or
`{ kind: 'module', module: 'CatsModule', modules: Set<string> }`; `inScope(scope, moduleName)`.

### 2. Tools

`src/tools/graph.tools.ts`, `registerGraphTools(registry, context)`:

| Tool | Input (zod) | Output |
|------|-------------|--------|
| `graph_modules` | `{ includeInternal?: boolean }` | Modules in scope: `name`, `global`, `dynamic`, provider and controller counts, `imports` |
| `graph_module` | `{ name: string }` | The module with imports, exports, providers (name, scope, exported), controllers, and who imports it |
| `graph_providers` | `{ filter?: string; module?: string; scope?: 'DEFAULT'\|'REQUEST'\|'TRANSIENT'; includeInternal?: boolean }` | Matching providers (case-insensitive substring) |
| `graph_provider` | `{ token: string }` | The provider with module, scope, `dependsOn` (tokens) and `dependents` (who injects it), `initTimeMs` |
| `graph_cycles` | — | Cycles between modules (Tarjan over `module-to-module`) and between classes; `[]` if none |

Every answer carries `scope` so the agent knows what it is looking at.

### 3. Tests and docs

`test/graph.spec.ts`: modules, `graph_module('CatsModule')`, `graph_provider('CatsService')` with
`dependsOn: ['OwnersService']` and `dependents: ['CatsController']`, `graph_cycles` empty, a boot with
`snapshot: false` answering `snapshot_disabled`, and the `forFeature` instance seeing only its closure.
"Graph" section in the README.

## Files

### Created

- `src/graph/{model.ts,graph-reader.ts,cycles.ts}`, `src/instance/scope.ts`
- `src/tools/graph.tools.ts`
- `test/graph.spec.ts`

### Modified

- `src/nest-mcp.module.ts` (provides `GraphReader`, registers the group), `src/tools/app.tools.ts`
  (`scope`, `snapshot`, `tools.graph` for real)
- `README.md`

## Verification / definition of done

- [x] `yarn test` green with `graph.spec.ts`.
- [x] With `snapshot: false` the five tools answer `snapshot_disabled` with `isError: true`.
- [x] `graph_provider` on an unknown token answers `{ error: 'not_found', candidates: [...] }` with up
      to five similar names.
- [x] No answer contains instances or functions (`JSON.stringify` without `[Function]` or cycles).
- [x] The `forFeature` instance's `graph_modules` excludes modules outside its closure.
- [x] `yarn build`, `lint`, `type-check` green.

## Likely stumbles

- **`SerializedGraph` not injectable in Nest 10.4**: `devtools-integration` injects it and supports
  Nest 10, so it should be. If not, fetch it with `app.get(SerializedGraph, { strict: false })` from
  `NestMcpBootstrap` and hand it to the reader.
- **Non-deterministic ids**: graph ids change between boots. Tools work by name; ids never reach the
  agent.
- **Finding the instance's own module node**: dynamic modules get a token derived from their metadata;
  with several instances the names collide (`NestMcpModule`). Match by the instance's options provider
  value (the resolved options object is unique per instance) rather than by name.
- **`forwardRef` and dynamic modules** may appear twice with the same name; disambiguate by id suffix
  only on collision.
- **Global enhancer nodes** (`APP_GUARD`) hang off modules with a `subtype`; they are not ordinary
  providers and `graph_providers` marks them.

## Phase closure — two mandatory commits

As in phase 1: commit 1 with the work (without `CHANGELOG.md`), for example
`feat(nestjs-mcp): expose the module and provider graph and resolve instance scope (Phase 2)`;
commit 2 with the logbook entry only, `chore(nestjs-mcp): close phase 2`, carrying commit 1's hash;
then, if a host embeds this repo as a submodule, its pointer on the host side. The person launches them.

## Notes for the next session (Phase 3)

- `GraphModel.classes[*].enhancers` (from `ClassNode.metadata.enhancers`, with `methodKey`) is what
  phase 3 uses for per-route enhancers. Keep them in the model even though phase 2 does not expose them.
- `inScope` is the filter every later group applies.
