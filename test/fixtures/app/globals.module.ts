import {
  DynamicModule,
  forwardRef,
  Global,
  Inject,
  Injectable,
  Module,
  type Type,
} from '@nestjs/common';
import { NestMcpModule } from '@jsirp/nestjs-mcp';

export const FEATURE_INSPECTOR_PATH = 'feature';

@Injectable()
export class GlobalBService {}

@Global()
@Module({ providers: [GlobalBService], exports: [GlobalBService] })
export class GlobalBModule {}

@Injectable()
export class GlobalAService {}

@Global()
@Module({ imports: [GlobalBModule], providers: [GlobalAService], exports: [GlobalAService] })
export class GlobalAModule {}

/** Injects a global provider without importing its module. */
@Injectable()
export class FeatureService {
  constructor(@Inject(GlobalBService) readonly globalB: GlobalBService) {}
}

/** Imports neither global module; optionally mounts a `forFeature` instance. */
@Module({ providers: [FeatureService] })
export class FeatureModule {
  static with(inspector: boolean): DynamicModule {
    return {
      module: FeatureModule,
      imports: inspector ? [NestMcpModule.forFeature({ path: FEATURE_INSPECTOR_PATH })] : [],
    };
  }
}

/** Declares a global module in its imports, which Nest would have linked anyway. */
@Module({ imports: [GlobalBModule] })
export class DeclaringModule {}

@Module({ imports: [forwardRef(() => LoopBModule)] })
export class LoopAModule {}

@Module({ imports: [forwardRef(() => LoopAModule)] })
export class LoopBModule {}

/** Two `@Global()` modules (A imports B), a feature that imports neither and a real cycle. */
export function globalsFixture(options: {
  featureInspector?: boolean;
}): Array<Type | DynamicModule> {
  return [
    GlobalAModule,
    GlobalBModule,
    FeatureModule.with(options.featureInspector === true),
    DeclaringModule,
    LoopAModule,
  ];
}
