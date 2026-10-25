import { CanActivate, Injectable } from '@nestjs/common';

/** Registered with `app.useGlobalGuards(new GlobalGuard())`: an instance, not a provider. */
export class GlobalGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** Registered as an `APP_GUARD` provider. */
@Injectable()
export class AppGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
