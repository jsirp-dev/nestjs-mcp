import {
  ConfigurableModuleBuilder,
  Inject,
  Module,
  Optional,
  type CanActivate,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ApplicationConfig, ModulesContainer, SerializedGraph } from '@nestjs/core';
import { NEST_MCP_INSTANCE, NEST_MCP_OPTIONS, NEST_MCP_TOOL_CONTEXT } from './constants.js';
import { NestMcpBootstrap } from './nest-mcp.bootstrap.js';
import {
  defaultEnabled,
  resolveOptions,
  resolvePath,
  type InstanceScopeKind,
  type NestMcpAsyncOptions,
  type NestMcpFactoryOptions,
  type NestMcpFeatureAsyncOptions,
  type NestMcpFeatureOptions,
  type NestMcpOptions,
  type NestMcpStaticOptions,
  type ResolvedNestMcpOptions,
} from './nest-mcp.options.js';
import {
  installRequestTracing,
  type TracingApplicationConfigLike,
} from './requests/trace.middleware.js';
import type { ModulesContainerLike } from './requests/wrap-enhancers.js';
import { ToolRegistry } from './tools/registry.js';
import type { SerializedGraphLike } from './graph/graph-reader.js';
import {
  createToolContext,
  type ApplicationConfigLike,
  type ToolContext,
} from './tools/tool-context.js';
import { NestMcpToolsSetup } from './tools/tools-setup.js';
import { EnabledGuard } from './transport/enabled.guard.js';
import { LocalOnlyGuard } from './transport/local-only.guard.js';
import { createInstanceController } from './transport/nest-mcp.controller.js';

/**
 * The "extras" of the configurable module: what is known when `forRoot`/`forFeature` (or their
 * async variants) is called, before Nest scans the module. `scope` is set by the method.
 */
interface InstanceExtras extends NestMcpStaticOptions {
  scope: InstanceScopeKind;
}

const STATIC_KEYS = ['enabled', 'path', 'guards', 'localOnly'] as const;

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<NestMcpFactoryOptions>({ moduleName: 'NestMcp' })
    .setClassMethodName('forRoot')
    .setExtras<InstanceExtras>(
      {
        scope: 'app',
        enabled: undefined,
        path: undefined,
        guards: undefined,
        localOnly: undefined,
      },
      (definition, extras) => defineInstance(definition, extras),
    )
    .build();

function staticOptions(extras: InstanceExtras): NestMcpStaticOptions {
  const picked: NestMcpStaticOptions = {};
  for (const key of STATIC_KEYS) {
    if (extras[key] !== undefined) Object.assign(picked, { [key]: extras[key] });
  }
  return picked;
}

function isSync(definition: DynamicModule): boolean {
  return (definition.providers ?? []).some(
    (provider) =>
      typeof provider === 'object' &&
      'provide' in provider &&
      provider.provide === MODULE_OPTIONS_TOKEN &&
      'useValue' in provider,
  );
}

/**
 * Turns the builder's definition into one instance: resolved options always; and, when enabled,
 * its own controller subclass, tool registry, tool context and bootstrap.
 */
function defineInstance(definition: DynamicModule, extras: InstanceExtras): DynamicModule {
  const scope = extras.scope;
  const fixed = staticOptions(extras);
  // Throws now, at definition time, for `forFeature` without `path`.
  const path = resolvePath(fixed.path, scope);
  // Sync: everything is known. Async: only a static `enabled` is; otherwise the factory decides.
  const enabled = fixed.enabled ?? (isSync(definition) ? defaultEnabled() : undefined);

  const optionsProvider: Provider = {
    provide: NEST_MCP_OPTIONS,
    useFactory: (raw: NestMcpFactoryOptions | undefined): ResolvedNestMcpOptions =>
      resolveOptions({ ...(raw ?? {}), ...fixed, enabled: fixed.enabled ?? raw?.enabled }, scope),
    inject: [MODULE_OPTIONS_TOKEN],
  };
  const providers = [...(definition.providers ?? []), optionsProvider];
  if (enabled === false) return { ...definition, providers };

  const guards: Type<CanActivate>[] = [
    ...(enabled === undefined ? [EnabledGuard] : []),
    ...((fixed.localOnly ?? true) ? [LocalOnlyGuard] : []),
    ...(fixed.guards ?? []),
  ];
  // Unique per instance: its node in the serialized graph says which module is this instance's.
  const instanceToken = Symbol(NEST_MCP_INSTANCE);
  const instanceProvider: Provider = { provide: instanceToken, useValue: instanceToken };
  const toolContextProvider: Provider = {
    provide: NEST_MCP_TOOL_CONTEXT,
    useFactory: (
      options: ResolvedNestMcpOptions,
      applicationConfig: ApplicationConfigLike,
      serializedGraph: SerializedGraphLike | undefined,
    ) => createToolContext(options, applicationConfig, serializedGraph, instanceToken),
    inject: [NEST_MCP_OPTIONS, ApplicationConfig, { token: SerializedGraph, optional: true }],
  };

  return {
    ...definition,
    controllers: [...(definition.controllers ?? []), createInstanceController(path, guards)],
    providers: [
      ...providers,
      instanceProvider,
      toolContextProvider,
      ToolRegistry,
      NestMcpToolsSetup,
      NestMcpBootstrap,
    ],
  };
}

/**
 * The inspector. `forRoot` observes the whole app; `forFeature` observes the module that imports
 * it and everything that module imports. Any number of instances may coexist, each on its path.
 */
@Module({})
export class NestMcpModule extends ConfigurableModuleClass implements NestModule {
  constructor(
    @Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions,
    @Inject(ModulesContainer) private readonly modulesContainer: ModulesContainerLike,
    @Inject(ApplicationConfig) private readonly applicationConfig: TracingApplicationConfigLike,
    @Optional() @Inject(NEST_MCP_TOOL_CONTEXT) private readonly context?: ToolContext,
  ) {
    super();
  }

  /**
   * Installs request tracing when the `requests` group is on. Nest calls `configure` before it
   * builds the routes, and building them binds each exception filter's `catch` for good, so the
   * enhancers are wrapped here rather than in a lifecycle hook.
   */
  configure(consumer: MiddlewareConsumer): void {
    if (!this.options.enabled || !this.options.tools.requests || !this.context) return;
    this.context.traces = installRequestTracing({
      options: this.options.requests,
      modulesContainer: this.modulesContainer,
      applicationConfig: this.applicationConfig,
      consumer,
      mcpPath: this.context.mcpPath(),
    });
  }

  static override forRoot(options: NestMcpOptions = {}): DynamicModule {
    return super.forRoot({ ...options, scope: 'app' });
  }

  /** `path`, `guards`, `localOnly` and, optionally, `enabled` go here, not in the factory. */
  static override forRootAsync(options: NestMcpAsyncOptions): DynamicModule {
    return super.forRootAsync({ ...options, scope: 'app' });
  }

  static forFeature(options: NestMcpFeatureOptions): DynamicModule {
    return super.forRoot({ ...options, scope: 'module' });
  }

  static forFeatureAsync(options: NestMcpFeatureAsyncOptions): DynamicModule {
    return super.forRootAsync({ ...options, scope: 'module' });
  }
}
