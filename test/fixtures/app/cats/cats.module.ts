import { DynamicModule, Module } from '@nestjs/common';
import { NestMcpModule, type NestMcpFeatureOptions } from '@jsirp/nestjs-mcp';
import { OwnersModule } from '../owners/owners.module.js';
import { CatsController } from './cats.controller.js';
import { CatsService } from './cats.service.js';
import { LoggingService } from './logging.service.js';

export const CATS_INSPECTOR_PATH = '_mcp/cats';

@Module({
  imports: [OwnersModule],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {
  /**
   * The cats module, optionally with its own module-scoped inspector instance (with `inspector`
   * as its options) and with `LoggingService`.
   */
  static with(
    options: { inspector?: boolean | Partial<NestMcpFeatureOptions>; logging?: boolean } = {},
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
      providers: options.logging ? [LoggingService] : [],
    };
  }
}
