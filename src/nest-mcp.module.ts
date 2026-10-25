import {
  ConfigurableModuleBuilder,
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { ApplicationConfig, ModulesContainer, SerializedGraph } from '@nestjs/core';
import {
  DEFAULT_EVENTS_BUFFER_SIZE,
  NEST_MCP_INSTANCE,
  NEST_MCP_OPTIONS,
  NEST_MCP_TOOL_CONTEXT,
} from './constants.js';
import { installEvents } from './events/install-events.js';
import { installRuns } from './runs/install-runs.js';
import { installSchedule } from './schedule/install-schedule.js';
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

/**
 * The "extras" of the configurable module: what is known when `forRoot`/`forFeature` (or their
 * async variants) is called, before Nest scans the module. `scope` is set by the method.
 */
interface InstanceExtras extends NestMcpStaticOptions {
  scope: InstanceScopeKind;
}

const STATIC_KEYS = ['enabled', 'path'] as const;

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<NestMcpFactoryOptions>({ moduleName: 'NestMcp' })
    .setClassMethodName('forRoot')
    .setExtras<InstanceExtras>(
      {
        scope: 'app',
        enabled: undefined,
        path: undefined,
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
 * Turns the builder's definition into one instance: resolved options always; and, unless a static
 * `enabled: false` says otherwise, its tool registry, tool context and bootstrap. No controller:
 * the instance answers on the inspector's own listener.
 */
function defineInstance(definition: DynamicModule, extras: InstanceExtras): DynamicModule {
  const scope = extras.scope;
  const fixed = staticOptions(extras);
  // Throws now, at definition time, for `forFeature` without `path`.
  resolvePath(fixed.path, scope);
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
   * Installs request tracing when the `requests` group is on, the emission recorder when the
   * `events` group is, the job and listener wrappers when the `runs` group is, and looks up the
   * scheduler registry when the `schedule` group is. Nest calls `configure` before it builds the
   * routes, and building them binds each exception filter's `catch` for good, so the enhancers are
   * wrapped here rather than in a lifecycle hook; and it runs before every `onModuleInit` of the
   * app, so the recorder sees the emissions of the app's own hooks and the scheduler, which reads
   * the job methods at its `onModuleInit`, binds the wrappers (ADR-0006).
   */
  configure(consumer: MiddlewareConsumer): void {
    if (!this.options.enabled || !this.context) return;
    if (this.options.tools.events) {
      this.context.events = installEvents(this.modulesContainer, DEFAULT_EVENTS_BUFFER_SIZE);
    }
    if (this.options.tools.schedule) this.context.schedule = installSchedule(this.modulesContainer);
    if (this.options.tools.runs) {
      this.context.runs = installRuns(this.modulesContainer, this.options.runs.bufferSize);
    }
    if (!this.options.tools.requests) return;
    this.context.traces = installRequestTracing({
      options: this.options.requests,
      modulesContainer: this.modulesContainer,
      applicationConfig: this.applicationConfig,
      consumer,
    });
  }

  static override forRoot(options: NestMcpOptions = {}): DynamicModule {
    return super.forRoot({ ...options, scope: 'app' });
  }

  /** `path` and, optionally, `enabled` go here, not in the factory. */
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
