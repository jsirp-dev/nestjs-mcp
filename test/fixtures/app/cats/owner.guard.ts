import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { OwnersService } from '../owners/owners.service.js';

export const OWNER_HEADER = 'x-owner';

/**
 * Lets a request through unless it names, in `x-owner`, an owner the injected `OwnersService`
 * does not know; then it returns `false` (Nest answers 403). Uses `this`, so a wrapper that lost
 * it would throw.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(@Inject(OwnersService) private readonly owners: OwnersService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const owner = request.headers[OWNER_HEADER];
    return owner === undefined || this.owners.findById(Number(owner)) !== undefined;
  }
}
