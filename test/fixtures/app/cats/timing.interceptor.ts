import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(n: string, v: string): void }>();
    return next
      .handle()
      .pipe(tap(() => response.setHeader('x-elapsed-ms', String(Date.now() - startedAt))));
  }
}
