import { DynamicModule, Module, Scope } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { NestMcpModule, type NestMcpFeatureOptions } from '@jsirp/nestjs-mcp';
import { OwnersModule } from '../owners/owners.module.js';
import { CatsController } from './cats.controller.js';
import { CatsService } from './cats.service.js';
import { LoggingService } from './logging.service.js';
import { OwnerGuard } from './owner.guard.js';
import { RequestScopedInterceptor } from './request-scoped.interceptor.js';

export const CATS_INSPECTOR_PATH = '_mcp/cats';

@Module({
  imports: [OwnersModule],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {
  /**
   * The cats module, optionally with its own module-scoped inspector instance (with `inspector`
   * as its options), with `LoggingService`, with `OwnerGuard` as an `APP_GUARD` and with
   * `RequestScopedInterceptor` as a request-scoped `APP_INTERCEPTOR`.
   */
  static with(
    options: {
      inspector?: boolean | Partial<NestMcpFeatureOptions>;
      logging?: boolean;
      ownerGuard?: boolean;
      requestScoped?: boolean;
    } = {},
  ): DynamicModule {
    const inspector =
      typeof options.inspector === 'object'
        ? { path: CATS_INSPECTOR_PATH, ...options.inspector }
        : options.inspector
          ? { path: CATS_INSPECTOR_PATH }
          : undefined;
    return {
      module: CatsModule,
      imports: inspector ? [NestMcpModule.forFeature(inspector)] : [],
      providers: [
        ...(options.logging ? [LoggingService] : []),
        ...(options.ownerGuard ? [{ provide: APP_GUARD, useClass: OwnerGuard }] : []),
        ...(options.requestScoped
          ? [
              {
                provide: APP_INTERCEPTOR,
                useClass: RequestScopedInterceptor,
                scope: Scope.REQUEST,
              },
            ]
          : []),
      ],
    };
  }
}
