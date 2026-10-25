import {
  ArgumentsHost,
  Body,
  CallHandler,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  Injectable,
  Logger,
  MiddlewareConsumer,
  Module,
  NestInterceptor,
  NestMiddleware,
  NestModule,
  NotFoundException,
  PipeTransform,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import multer from 'multer';
import { Observable } from 'rxjs';

/**
 * Parses multipart bodies with multer, which calls `next` from busboy's stream callbacks. Pinned
 * to a multer that does not carry the async context across them (2.3.0 and later do).
 */
@Injectable()
export class UploadMiddleware implements NestMiddleware {
  private readonly parse = multer({ storage: multer.memoryStorage() }).single('file');

  use(request: never, response: never, next: (error?: unknown) => void): void {
    this.parse(request, response, (error?: unknown) => next(error));
  }
}

@Injectable()
export class UploadGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
export class UploadInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

@Injectable()
export class UploadPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return value;
  }
}

@Catch(NotFoundException)
export class UploadFilter implements ExceptionFilter {
  catch(_exception: NotFoundException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(404)
      .json({ error: 'missing' });
  }
}

@Controller('uploads')
@UseGuards(UploadGuard)
@UseInterceptors(UploadInterceptor)
@UseFilters(UploadFilter)
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  @Post('form')
  form(@Body(UploadPipe) body: Record<string, unknown>): { fields: number } {
    this.logger.log('form received');
    return { fields: Object.keys(body ?? {}).length };
  }

  @Post('missing')
  missing(): never {
    throw new NotFoundException();
  }
}

/** Applies multer to its own routes, in its `configure`, as a feature module does. */
@Module({ controllers: [UploadController], providers: [UploadGuard] })
export class UploadModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(UploadMiddleware).forRoutes(UploadController);
  }
}

/** Imports `UploadModule`, so multer is declared two levels below the root. Imported when asked. */
@Module({ imports: [UploadModule] })
export class UploadFeatureModule {}
