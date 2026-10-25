import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import { CatsModule } from './cats/cats.module.js';
import { AppGuard } from './global.guards.js';
import { TraceModule } from './trace.middleware.js';

type RootInspector =
  | { kind: 'none' }
  | { kind: 'sync'; options?: Parameters<typeof NestMcpModule.forRoot>[0] }
  | { kind: 'async'; options: Parameters<typeof NestMcpModule.forRootAsync>[0] };

export interface FixtureAppOptions {
  /** How the root instance is mounted. Defaults to `forRoot()` with no options. */
  root?: RootInspector;
  /** Mount a `forFeature` instance inside `CatsModule`. */
  catsInspector?: boolean;
  /** Provide `AppGuard` as an `APP_GUARD`. */
  appGuard?: boolean;
  /** Apply `TraceMiddleware` to the cats routes. */
  middleware?: boolean;
}

@Module({})
export class AppModule {
  static with(options: FixtureAppOptions = {}): DynamicModule {
    const root = options.root ?? { kind: 'sync' };
    const inspector =
      root.kind === 'sync'
        ? [NestMcpModule.forRoot(root.options)]
        : root.kind === 'async'
          ? [NestMcpModule.forRootAsync(root.options)]
          : [];
    return {
      module: AppModule,
      imports: [
        CatsModule.with({ inspector: options.catsInspector }),
        ...inspector,
        ...(options.middleware ? [TraceModule] : []),
      ],
      providers: options.appGuard ? [{ provide: APP_GUARD, useClass: AppGuard }] : [],
    };
  }
}
