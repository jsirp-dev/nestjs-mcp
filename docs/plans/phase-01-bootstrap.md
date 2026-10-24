# Phase 1 — Package bootstrap and MCP endpoint

> Master plan: [`00-overview.md`](./00-overview.md)
> Next phase: [`phase-02-graph.md`](./phase-02-graph.md)

## Objective

`packages/nestjs-mcp` exists as a publishable package. `NestMcpModule.forRoot(options)` and
`NestMcpModule.forFeature(options)` (plus their `*Async` variants, through Nest's
`ConfigurableModuleBuilder`) mount, when enabled, a stateless Streamable HTTP MCP endpoint in the app,
one controller subclass per instance, with `LocalOnlyGuard`, the configured `guards`, the bootstrap
warnings and a first tool, `app_info`. Disabled, nothing is registered. The phase leaves the fixture
app and the test harness every later phase uses, plus the logbook and the README.

At the end: `yarn test` boots the fixture app, an SDK `Client` does `initialize`, `tools/list` and
calls `app_info`, and the answer carries the Nest version, the global prefix, the endpoint path and the
instance's scope kind.

## Prerequisites

- [ ] The repo initialised (branch `main`, remote `git@github.com:jsirp-dev/nestjs-mcp.git`) with the
      plan committed.
- [ ] `CLAUDE.md`, `00-overview.md`, `GLOSSARY.md` and the ADRs read.
- [ ] If this checkout lives inside a host monorepo as a workspace, the host's install and build green
      before touching anything; the host's own conventions apply to the host's files only.

## Closed decisions for this phase

- **Stateless Streamable HTTP** (`sessionIdGenerator: undefined`): a new `McpServer` and transport per
  `POST`; `GET` and `DELETE` → 405.
- **`ConfigurableModuleBuilder`** builds the four static methods. `forRoot` and `forFeature` differ in
  one extra option: `scope: 'app' | 'module'`, set by the method, not by the user. `path` defaults to
  `_mcp` for `forRoot` and is **required** for `forFeature` (the importing module's name is not known
  when the decorator argument is evaluated: the class is in its temporal dead zone).
- **One controller subclass per instance**: `forRoot`/`forFeature` create `class extends NestMcpController`
  and write `PATH_METADATA`, `GUARDS_METADATA` and the version-neutral controller options on the subclass,
  before Nest scans the module. Two instances never share metadata.
- **Guards**: `LocalOnlyGuard` (if `localOnly`) followed by `options.guards`.
- **Warnings at bootstrap**, once per instance, context `NestMcp`: the endpoint URL (`log`), endpoint
  open to the network without guards (`warn`), `snapshot` missing (`warn`, with the exact option to
  set; the check reads whether `SerializedGraph` has nodes).
- **Tool registry is internal**: `ToolRegistry` is not exported; each tool group plugs in through
  `registerXTools(registry, context)`; `tools.<group>` switches decide which groups register.
- **`enabled: false` = empty module**: the dynamic module carries only the options provider.

## Steps

### 1. Package skeleton

`package.json` (`@jsirp/nestjs-mcp`, MIT, `type: module`, ESM + CJS `exports`, `files` limited to
`dist`, `README.md`, `CHANGELOG.md`, `LICENSE`, `publishConfig.access: public`, `engines.node >=20`,
`packageManager: yarn@4.3.1`, explicit `volta`). Peers: `@nestjs/common` and `@nestjs/core` `>=10 <12`,
`reflect-metadata`, `rxjs`, `zod` (`^3.25.0 || ^4.0.0`); optional peers `@nestjs/event-emitter`,
`@nestjs/schedule`. The only runtime dependency is `@modelcontextprotocol/sdk`. Scripts: `build`
(tsup), `dev`, `format`, `format-check`, `lint`, `type-check`, `test` (jest, `pretest` builds),
`postinstall: test -d .git && husky || true`.

Self-contained tooling, nothing from any host: `tsconfig.json` (`NodeNext`, decorators on, `types:
node, jest`), `tsup.config.ts` (`esm` + `cjs`, `dts`, `external` for Nest, `reflect-metadata`, `rxjs`,
the SDK and zod), `jest.config.cjs` (ts-jest as CommonJS with decorator metadata, `.js` import mapping),
`.eslintrc.cjs` (`@typescript-eslint/recommended` + `prettier` + `eslint-plugin-import` with
`import/no-extraneous-dependencies`, so nothing outside `package.json` can be imported), `.prettierrc.cjs`, `.gitignore`, `.nvmrc`, `.yarnrc.yml`, husky with a
check-only `.husky/pre-commit` (`format-check && lint && type-check && build`), `LICENSE`.

### 2. Options and module

`src/nest-mcp.options.ts`: `NestMcpOptions` (the public table in the master plan), `tools` group
switches, `requests.headers: 'none' | 'names' | 'full'`, and `resolveOptions(partial, scope)` returning
`ResolvedNestMcpOptions` with every default applied and `path` normalised (no leading or trailing
slashes). `forFeature` without `path` throws at definition time with a message naming the option.

`src/nest-mcp.module.ts` with `ConfigurableModuleBuilder<NestMcpOptions>`:

```ts
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<NestMcpOptions>({ moduleName: 'NestMcp' })
    .setClassMethodName('forRoot')
    .setExtras({ scope: 'app' as InstanceScopeKind }, (definition, extras) => decorate(definition, extras))
    .build();
```

`forFeature`/`forFeatureAsync` are thin wrappers that call the same builder output with
`scope: 'module'`. Because async options are not known until the factory runs, the controller subclass
is created per call regardless, and the **path and guards are resolved synchronously**: for the async
variants, `path`, `guards` and `localOnly` must be given statically (`forRootAsync({ path, guards,
useFactory })`); everything else may come from the factory. The README says so.

Providers per instance: `NEST_MCP_OPTIONS` (resolved), `NEST_MCP_TOOL_CONTEXT` (factory over
`ApplicationConfig`, `SerializedGraph` optional), `ToolRegistry`, `LocalOnlyGuard`, the user guards,
`NestMcpToolsSetup` (registers the groups that are on), `NestMcpBootstrap` (warnings).

### 3. Transport

`src/transport/nest-mcp.controller.ts`: `@Controller({ version: VERSION_NEUTRAL })`, constructor with
explicit `@Inject`s, `@Post()` creating server + transport and delegating to
`transport.handleRequest(req, res, req.body)` (Nest has already parsed the body), `@Get()` and
`@Delete()` answering 405 with an `Allow: POST` header. `src/transport/create-mcp-server.ts` builds the
`McpServer` from the registry (narrow call signature at the SDK boundary; the SDK's generic over mixed
zod shapes blows up in some TypeScript configurations).

### 4. `LocalOnlyGuard`, `app_info`

`LocalOnlyGuard.canActivate` reads `req.socket.remoteAddress` (fallback `req.ip`) and accepts
`127.0.0.1`, `::1`, `::ffff:127.0.0.1`; otherwise `ForbiddenException` naming `localOnly`.

`app_info` (no input) answers:

```json
{ "server": { "name": "…", "version": "…" }, "nest": "11.2.3", "node": "v20.19.4", "uptimeSeconds": 12,
  "globalPrefix": "api", "versioning": { "type": "URI", "defaultVersion": "1" }, "mcpPath": "/api/_mcp",
  "scope": { "kind": "app" }, "snapshot": true,
  "tools": { "graph": false, "routes": false, "logs": false, "requests": false, "events": false, "schedule": false } }
```

`scope` is `{ kind: 'module', module: null }` for `forFeature` until phase 2 resolves the name.
`snapshot` says whether `SerializedGraph` has nodes. `tools` reports which groups are live (all `false`
in this phase except what the switches would allow once the groups exist).

### 5. Fixture app and harness

`test/fixtures/app/`: `CatsModule` (`GET /cats`, `GET /cats/:id` with `ParseIntPipe`, class-level
`ApiKeyGuard`, `TimingInterceptor`, `NotFoundFilter`) importing `OwnersModule` (exports `OwnersService`,
injected by `CatsService`). `AppModule.with(options)` adds `NestMcpModule.forRoot(options)`;
`CatsModule` additionally mounts `NestMcpModule.forFeature({ path: '_mcp/cats' })` when the harness asks
for it. Everything invented; nothing from any host.

`test/support/start-app.ts`: boots the app on `127.0.0.1:0` with `snapshot` (default on), optional
global prefix and URI versioning, exposes `connect()` returning an SDK `Client` on
`StreamableHTTPClientTransport`, `fetch` helpers and `close()`.

`test/transport.spec.ts`: `tools/list` contains `app_info`; `app_info` reports prefix, path, scope and
versioning; version-neutral under URI versioning (`/api/v1/_mcp` → 404); custom path; `enabled: false`
→ 404 with app routes intact; a `DenyAllGuard` in `guards` → 403; `forFeature` instance answers on its
own path with `scope.kind: 'module'` while the root instance keeps `app`; `forFeature` without `path`
throws; `forRootAsync` with `useFactory` works; `LocalOnlyGuard` unit cases.

### 6. Logbook and README

- `CHANGELOG.md` with the logbook header only (its first entry is commit 2 of this phase).
- `README.md`: install, quick start (`forRoot`, `forFeature`, `forRootAsync` with
  `ConfigService`), options table, tools table with status, how to point Claude Code, security,
  limitations.

## Files

### Created (package repo)

- `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md`, `tsconfig.json`, `tsup.config.ts`,
  `jest.config.cjs`, `.eslintrc.cjs`, `.prettierrc.cjs`, `.gitignore`, `.nvmrc`, `.yarnrc.yml`,
  `.husky/pre-commit`
- `src/index.ts`, `src/constants.ts`, `src/nest-mcp.module.ts`, `src/nest-mcp.options.ts`,
  `src/nest-mcp.bootstrap.ts`
- `src/transport/{nest-mcp.controller.ts,local-only.guard.ts,create-mcp-server.ts}`
- `src/tools/{registry.ts,tool-context.ts,app.tools.ts}`
- `test/fixtures/app/**`, `test/support/start-app.ts`, `test/transport.spec.ts`

### Modified

- `docs/plans/README.md` (phase status)

A host monorepo that lists this folder as a workspace will see its own lockfile and build graph
change; that is the host's commit, on its side.

## Verification / definition of done

- [ ] `yarn install` changes nothing but `yarn.lock`.
- [ ] `yarn build` produces `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`.
- [ ] `yarn test` green with `test/transport.spec.ts`.
- [ ] `yarn lint` and `yarn type-check` green; a file importing a package absent from `package.json`
      fails lint with `import/no-extraneous-dependencies` (checked and reverted).
- [ ] `sh .husky/pre-commit` passes by hand.
- [ ] `git grep -n -i 'pino\|orpc\|mongo' src test` returns nothing: no assumptions about a host.

## Likely stumbles

- **`@modelcontextprotocol/sdk` and zod**: the SDK's peer is `^3.25 || ^4`; a host may hoist an older zod.
  `yarn why zod` shows what the SDK resolves. If `registerTool` rejects a schema, this is it.
- **Deep imports into `@nestjs/common`** (`/constants`, `/interfaces/...`) do not resolve under
  `NodeNext`. Declare the metadata keys locally (`'path'`, `'__guards__'`, stable since Nest 7) and
  derive types from `ApplicationConfig`.
- **`@Version` is a method decorator**: version-neutral at class level is `@Controller({ version:
  VERSION_NEUTRAL })`.
- **The SDK's `registerTool` generic** over mixed zod shapes fails ts-jest with "excessively deep":
  call it through a narrow signature at the boundary.
- **ts-jest and `.js` import extensions**: `NodeNext` wants them in `test/`; `moduleNameMapper` maps
  them back.
- **Body already parsed**: pass `req.body` as the third argument of `handleRequest`; otherwise the SDK
  tries to read a consumed stream.
- **`getUrl()`** returns `http://[::1]:PORT` on some machines; listen on `127.0.0.1` in tests.
- **Async options and the controller route**: the route metadata must exist before Nest scans, so
  `path`, `guards` and `localOnly` cannot come from an async factory. Document it instead of fighting it.

## Phase closure — two mandatory commits

### Commit 1 — work

1. ✅ Tick every box in "Verification / definition of done".
2. ✅ `git add` the phase changes. **Without `CHANGELOG.md`** (created here with the header only: it
   belongs to commit 2). The plan, glossary, ADRs and `CLAUDE.md` are the repo's initial commit, before
   this one.
3. ✅ Message in English, for example:
   ```
   feat(nestjs-mcp): bootstrap the package with the embedded MCP endpoint (Phase 1)

   - NestMcpModule.forRoot/forRootAsync/forFeature/forFeatureAsync via ConfigurableModuleBuilder
   - One controller subclass per instance; stateless Streamable HTTP; GET and DELETE answer 405
   - LocalOnlyGuard, configurable guards, bootstrap warnings, app_info
   - Fixture app and SDK client test harness; self-contained tooling
   ```

### Commit 2 — administrative closure (CHANGELOG)

4. ✅ The phase entry in `CHANGELOG.md` with the method's template: done, deviations, hot decisions,
   stumbles, **critical information for later phases**, verification, and the **short hash of commit 1**.
5. ✅ `git add CHANGELOG.md` and `git commit -m "chore(nestjs-mcp): close phase 1"`.
6. ✅ If a host embeds this repo as a submodule, its pointer is committed on the host side, by the
   person, with whatever workspace wiring the host needs.

The person launches the commits: show the diff, wait for the OK, give each command in its own `bash`
block.

## Notes for the next session (Phase 2)

- `ToolRegistry` and `createMcpServer` are the extension point: phase 2 adds `registerGraphTools`.
- `NEST_MCP_TOOL_CONTEXT` already carries `SerializedGraph` when it is injectable; phase 2 reads it
  and resolves the module scope of `forFeature` instances (who imports this instance's dynamic module).
