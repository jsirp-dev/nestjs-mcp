import { DynamicModule, Module } from '@nestjs/common';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import { OwnersModule } from '../owners/owners.module.js';
import { CatsController } from './cats.controller.js';
import { CatsService } from './cats.service.js';

export const CATS_INSPECTOR_PATH = '_mcp/cats';

@Module({
  imports: [OwnersModule],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {
  /** The cats module, optionally with its own module-scoped inspector instance. */
  static with(options: { inspector?: boolean } = {}): DynamicModule {
    return {
      module: CatsModule,
      imports: options.inspector ? [NestMcpModule.forFeature({ path: CATS_INSPECTOR_PATH })] : [],
    };
  }
}
