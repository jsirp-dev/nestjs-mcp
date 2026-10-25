import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { LocalOnlyGuard } from '../src/transport/local-only.guard.js';

function contextFrom(request: { socket?: { remoteAddress?: string }; ip?: string }) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('LocalOnlyGuard', () => {
  const guard = new LocalOnlyGuard();

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', (remoteAddress) => {
    expect(guard.canActivate(contextFrom({ socket: { remoteAddress } }))).toBe(true);
  });

  it.each(['10.0.0.7', '192.168.1.20', '::ffff:10.0.0.7', '2001:db8::1'])(
    'rejects %s, naming localOnly',
    (remoteAddress) => {
      const check = () => guard.canActivate(contextFrom({ socket: { remoteAddress } }));
      expect(check).toThrow(ForbiddenException);
      expect(check).toThrow(/localOnly/);
    },
  );

  it('falls back to req.ip when the socket has no address', () => {
    expect(guard.canActivate(contextFrom({ ip: '127.0.0.1' }))).toBe(true);
    expect(() => guard.canActivate(contextFrom({ ip: '203.0.113.9' }))).toThrow(ForbiddenException);
  });

  it('rejects a request with no address at all', () => {
    expect(() => guard.canActivate(contextFrom({}))).toThrow(ForbiddenException);
  });
});
