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

/** A named function middleware: Nest wraps it in a class and gives that class a random name. */
export function stampRequest(_request: unknown, _response: unknown, next: () => void): void {
  next();
}

/**
 * Applies an arrow-function middleware and `stampRequest` to every route. Imported only when the
 * fixture asks for it.
 */
@Module({})
export class FunctionalMiddlewareModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: unknown, _response: unknown, next: () => void) => next(), stampRequest)
      .forRoutes('*');
  }
}
