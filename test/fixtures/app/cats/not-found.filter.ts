import { ArgumentsHost, Catch, ExceptionFilter, NotFoundException } from '@nestjs/common';

@Catch(NotFoundException)
export class NotFoundFilter implements ExceptionFilter {
  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    response.status(404).json({ error: 'cat_not_found', message: exception.message });
  }
}
