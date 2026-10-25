import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

/** A guard a host might put in front of the inspector; this one refuses everything. */
@Injectable()
export class DenyAllGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('Denied by DenyAllGuard');
  }
}
