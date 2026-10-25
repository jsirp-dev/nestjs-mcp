import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Rejects any request whose peer is not loopback. On by default (`localOnly: true`). */
@Injectable()
export class LocalOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ socket?: { remoteAddress?: string }; ip?: string }>();
    const address = request.socket?.remoteAddress ?? request.ip;
    if (address !== undefined && LOOPBACK.has(address)) return true;
    throw new ForbiddenException(
      `The inspector endpoint only accepts loopback requests (got ${address ?? 'unknown'}). ` +
        'Set `localOnly: false` and protect it with `guards` to open it to the network.',
    );
  }
}
