import {
  CallHandler,
  CanActivate,
  Controller,
  Get,
  Injectable,
  Module,
  NestInterceptor,
  Scope,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * A method decorator that replaces the handler with an anonymous wrapper, the shape auth, event
 * or RPC-adapter decorators have. Applied below `@Get`, so the route's metadata lands on the
 * wrapper.
 */
export function Wrap(): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original = descriptor.value as unknown as (...args: unknown[]) => unknown;
    (descriptor as PropertyDescriptor).value = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, args);
    };
    return descriptor;
  };
}

@Injectable()
export class WrappedGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** Request-scoped, so it has no instance to wrap and the trace lists it under `notTraced`. */
@Injectable({ scope: Scope.REQUEST })
export class WrappedScopedInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

@Controller('wrapped')
@UseGuards(WrappedGuard)
export class WrappedController {
  @Get('wrapped')
  @UseInterceptors(WrappedScopedInterceptor)
  @Wrap()
  wrapped(): { ok: 1 } {
    return { ok: 1 };
  }
}

/** A base class whose wrapped handler two controllers inherit: one function, two classes. */
export abstract class WrappedBase {
  @Get('inherited')
  @Wrap()
  inherited(): { from: string } {
    return { from: this.constructor.name };
  }
}

@Controller('derived-a')
export class DerivedAController extends WrappedBase {}

@Controller('derived-b')
export class DerivedBController extends WrappedBase {}

/** Handlers replaced by decorators. Imported when asked for. */
@Module({ controllers: [WrappedController, DerivedAController, DerivedBController] })
export class WrappedModule {}
