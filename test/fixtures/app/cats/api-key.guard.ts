import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

export const API_KEY_HEADER = 'x-api-key';
export const API_KEY = 'fixture-key';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (request.headers[API_KEY_HEADER] !== API_KEY) {
      throw new UnauthorizedException(`Missing or wrong ${API_KEY_HEADER}`);
    }
    return true;
  }
}
