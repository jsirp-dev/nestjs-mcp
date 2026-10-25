import { Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule } from '@nestjs/common';
import { CatsController } from './cats/cats.controller.js';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(_request: unknown, _response: unknown, next: () => void): void {
    next();
  }
}

/** Applies `TraceMiddleware` to the cats routes. Imported only when the fixture asks for it. */
@Module({})
export class TraceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes(CatsController);
  }
}
