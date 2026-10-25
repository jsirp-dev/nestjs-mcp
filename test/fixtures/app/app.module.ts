import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import {
  NestMcpModule,
  type NestMcpFeatureOptions,
  type NestMcpListenOptions,
} from '@jsirp/nestjs-mcp';
import { CatsModule } from './cats/cats.module.js';
import { AppGuard } from './global.guards.js';
import { HealthModule } from './health.module.js';
import { TraceModule } from './trace.middleware.js';
import { WrappedModule } from './wrapped.module.js';

type RootInspector =
  | { kind: 'none' }
  | { kind: 'sync'; options?: Parameters<typeof NestMcpModule.forRoot>[0] }
  | { kind: 'async'; options: Parameters<typeof NestMcpModule.forRootAsync>[0] };

export interface FixtureAppOptions {
  /** How the root instance is mounted. Defaults to `forRoot()` with no options. */
  root?: RootInspector;
  /**
   * `listen` given to the root instance (to the cats one without a root), unless that instance
   * sets its own. In an async root, merged under what the factory returns.
   */
  inspectorListen?: NestMcpListenOptions;
  /** Mount a `forFeature` instance inside `CatsModule`; an object gives its options. */
  catsInspector?: boolean | Partial<NestMcpFeatureOptions>;
  /** Provide `LoggingService` in `CatsModule`, which writes a warn and an error at bootstrap. */
  logging?: boolean;
  /** Provide `AppGuard` as an `APP_GUARD`. */
  appGuard?: boolean;
  /** Apply `TraceMiddleware` to the cats routes. */
  middleware?: boolean;
  /** Provide `OwnerGuard` (injects `OwnersService`) as an `APP_GUARD` from `CatsModule`. */
  ownerGuard?: boolean;
  /** Provide `RequestScopedInterceptor` as a request-scoped `APP_INTERCEPTOR`. */
  requestScoped?: boolean;
  /** Import `HealthModule`, a controller outside `CatsModule`. */
  health?: boolean;
  /** Import `WrappedModule`: handlers replaced by decorators. */
  wrapped?: boolean;
  /** Import `EventEmitterModule.forRoot`; an object gives its options (`wildcard`, …). */
  events?: boolean | Parameters<typeof EventEmitterModule.forRoot>[0];
  /** Import `ScheduleModule.forRoot`, which schedules the fixture's decorated jobs. */
  schedule?: boolean;
}

@Module({})
export class AppModule {
  static with(options: FixtureAppOptions = {}): DynamicModule {
    const root = options.root ?? { kind: 'sync' };
    const listen = options.inspectorListen ? { listen: options.inspectorListen } : {};
    const inspector =
      root.kind === 'sync'
        ? [NestMcpModule.forRoot({ ...listen, ...root.options })]
        : root.kind === 'async'
          ? [NestMcpModule.forRootAsync(withListen(root.options, listen))]
          : [];
    const catsInspector =
      root.kind === 'none' && options.catsInspector
        ? { ...listen, ...(options.catsInspector === true ? {} : options.catsInspector) }
        : options.catsInspector;
    return {
      module: AppModule,
      imports: [
        CatsModule.with({
          inspector: catsInspector,
          logging: options.logging,
          ownerGuard: options.ownerGuard,
          requestScoped: options.requestScoped,
        }),
        ...inspector,
        ...(options.middleware ? [TraceModule] : []),
        ...(options.health ? [HealthModule] : []),
        ...(options.wrapped ? [WrappedModule] : []),
        ...(options.events
          ? [EventEmitterModule.forRoot(options.events === true ? undefined : options.events)]
          : []),
        ...(options.schedule ? [ScheduleModule.forRoot()] : []),
      ],
      providers: options.appGuard ? [{ provide: APP_GUARD, useClass: AppGuard }] : [],
    };
  }
}

type AsyncRootOptions = Parameters<typeof NestMcpModule.forRootAsync>[0];

function withListen(
  options: AsyncRootOptions,
  listen: { listen?: NestMcpListenOptions },
): AsyncRootOptions {
  const { useFactory } = options;
  if (!useFactory || !listen.listen) return options;
  return {
    ...options,
    useFactory: async (...args: unknown[]) => ({ ...listen, ...(await useFactory(...args)) }),
  };
}
