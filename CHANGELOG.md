# Changelog

Development logbook of `@jsirp/nestjs-mcp`: one entry per closed phase, with fixed fields (done,
deviations from the plan, hot decisions, stumbles and resolutions, critical information for later
phases, verification, final commit). The phased plan is in [`docs/plans/`](docs/plans/).

Entries are in reverse chronological order. Each phase closure adds its block following the
two-commit convention (commit 1 = work, commit 2 = this entry).

Release notes for npm (`## 0.1.0`, …) are added above the logbook starting with the first release.

---

<!-- PHASE ENTRIES START HERE -->

## Phase 1 — Package bootstrap and MCP endpoint (2026-10-25)

**Work commits:** `20c7fed` (ticket #1), `a1f64c3` (ticket #2).

### Done

- Publishable package with self-contained tooling: its own `yarn.lock`, tsup ESM + CJS + `.d.ts`,
  ts-jest, ESLint with `import/no-extraneous-dependencies`, Prettier, a check-only husky pre-commit.
- `NestMcpModule.forRoot`/`forRootAsync`/`forFeature`/`forFeatureAsync` through
  `ConfigurableModuleBuilder`; `forFeature` without `path` throws at definition time naming the option.
- One controller subclass per instance, version-neutral, carrying its own path and guards metadata.
  Several instances coexist in one app, and two apps in one process keep their own path and guards.
- Stateless Streamable HTTP endpoint: `POST` serves MCP, `GET` and `DELETE` answer 405 with
  `Allow: POST`.
- `LocalOnlyGuard` followed by `options.guards`.
- Bootstrap log, once per instance, context `NestMcp`: the full endpoint URL (`log`). Two warnings
  (`warn`), each once per instance and only when its condition holds: the app was created without
  `snapshot: true`, and the endpoint is open to the network without guards.
- `app_info`: server info, Nest and Node versions, uptime, global prefix, versioning, endpoint path,
  scope kind, whether `snapshot` is on, live groups, and `options` (resolved tool switches and
  `requests.headers`).
- Fixture app (`CatsModule`, `OwnersModule`), SDK-client harness (`test/support/start-app.ts`) with a
  recording logger, and `test/transport.spec.ts`, `test/instances.spec.ts` and
  `test/local-only.guard.spec.ts`. README and this logbook.

### Deviations from the plan

- **`enabled` from an async factory cannot unregister the route**: the route exists before the
  factory runs. `EnabledGuard` answers 404 instead. A static `enabled` (sync, or next to `useFactory`)
  registers nothing.
- **User guards are not listed as providers.** Nest instantiates them from the guards metadata of the
  controller subclass, inside the inspector's module. Their dependencies must therefore come from
  global modules or from `imports` (async). The README says so.
- **`app_info` gained `options`** (`tools` switches and `requests.headers`). Ticket #2 wants the
  resolved switches visible. `app_info.tools` keeps its meaning (which groups are live), and in this
  phase every group reports `false`.

### Hot decisions

- `app_info.options` is a separate field, not a reinterpretation of `tools`. Later phases need both
  views: a group switched on whose optional peer is missing is `options.tools.x: true` with
  `tools.x: false`.
- Markdown is excluded from Prettier: the docs are hand-wrapped.

### Stumbles and resolutions

- An empty `yarn.lock` makes this folder its own Yarn project, so a host workspace is untouched.
- ESLint 8 silently skips `.ts` files without `--ext .ts,.cjs`. The flag is in the `lint` script.
- Deep imports into `@nestjs/common`/`@nestjs/core` need `.js` under `NodeNext`. The stable metadata
  keys are declared locally instead.
- The SDK's `registerTool` generic overflows with mixed zod shapes, so it is called through a narrow
  signature.
- **Yarn 4 does not run `pre*` scripts**, so `pretest` never builds. Run `yarn build` before
  `yarn test`, or tests run against a stale `dist/`. Left as is: the CI phase (6b) should make `test`
  build explicitly.

### Critical information for later phases

- Tests consume `dist/index.cjs` through `moduleNameMapper`, so they exercise the published build.
  That build emits no `design:paramtypes`, which proves the explicit `@Inject`s. For type-checking,
  `tsconfig` `paths` points the package name at `src`.
- The Nest version is read from `@nestjs/core/package.json` via `createRequire(__filename)`. tsup
  `shims: true` turns that into `import.meta.url` in the ESM build, which was smoke-tested.
- `ToolRegistry` plus `registerXTools(registry, context)` is the extension point. `NestMcpToolsSetup`
  is where each group is switched on through `options.tools.<group>`.
- `NEST_MCP_TOOL_CONTEXT` already carries `SerializedGraph` when it can be injected. Phase 2 resolves
  `scope.module`, which is `null` today.
- **Host risk (phase 7):** this checkout's own `node_modules` holds its own `@nestjs/core`. A host
  resolving the package source from here could load two Nest copies, and then class tokens such as
  `ApplicationConfig` would not match.
- Not run: the host's own install/build prerequisite, which is left unticked in the phase document.

### Verification

- `yarn build && yarn test`: 3 suites, 32 tests green.
- `yarn lint`, `yarn type-check`, `yarn format-check` and `sh .husky/pre-commit`: exit 0.
- `git grep -n -i 'pino\|orpc\|mongo' src test`: no matches.
