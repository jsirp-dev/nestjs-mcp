import 'reflect-metadata';
import { handlerKey } from '../src/support/handler-key.js';

function wrapper(): (...args: unknown[]) => unknown {
  return function () {
    return undefined;
  };
}

describe('handlerKey', () => {
  it('finds the key of a replaced method, whose function has no name', () => {
    class C {}
    const fn = wrapper();
    Object.defineProperty(C.prototype, 'wrapped', { value: fn, configurable: true });
    expect(fn.name).toBe('');
    expect(handlerKey(C, fn)).toBe('wrapped');
  });

  it("prefers the function's own name when the same function sits under several keys", () => {
    class C {
      original(): void {}
    }
    const proto = C.prototype as unknown as Record<string, unknown>;
    proto.alias = proto.original;
    expect(handlerKey(C, proto.original)).toBe('original');
    const anonymous = wrapper();
    proto.b = anonymous;
    proto.a = anonymous;
    expect(handlerKey(C, anonymous)).toBe('b');
  });

  it('finds an inherited handler from each subclass, and an override in the subclass', () => {
    class Base {
      inherited(): void {}
      overridden(): void {}
    }
    class A extends Base {}
    class B extends Base {
      override overridden(): void {}
    }
    const inherited = Base.prototype.inherited;
    expect(handlerKey(A, inherited)).toBe('inherited');
    expect(handlerKey(B, inherited)).toBe('inherited');
    expect(handlerKey(B, B.prototype.overridden)).toBe('overridden');
    // Not on B's chain: B's own `overridden` hides it.
    expect(handlerKey(B, Base.prototype.overridden)).toBeUndefined();
  });

  it('runs no getter of the prototype and answers undefined for a function it does not hold', () => {
    const getter = jest.fn(() => () => undefined);
    class C {}
    Object.defineProperty(C.prototype, 'computed', { get: getter, configurable: true });
    expect(handlerKey(C, wrapper())).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(handlerKey(undefined, wrapper())).toBeUndefined();
    expect(handlerKey(C, undefined)).toBeUndefined();
  });
});
