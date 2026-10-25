import { CallHandler, Injectable, NestInterceptor, Scope } from '@nestjs/common';
import { Observable } from 'rxjs';

/** A request-scoped interceptor: Nest creates one per request, so there is no instance to wrap. */
@Injectable({ scope: Scope.REQUEST })
export class RequestScopedInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
