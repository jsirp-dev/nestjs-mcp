import 'reflect-metadata';
import { Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { argumentName, argumentOf, routeArguments } from '../src/routes/route-arguments.js';
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

describe('route arguments', () => {
  class UpperPipe {
    transform(value: unknown): unknown {
      return value;
    }
  }

  class C {
    one(
      @Param('id', ParseIntPipe) _id: number,
      @Param(UpperPipe) _params: object,
      @Query() _query: object,
    ): void {}
    two(@Body(UpperPipe) _a: object, @Body() _b: object, @Body() _c: object): void {}
  }

  it('names each argument by its data, or #index without one', () => {
    expect(routeArguments(C, 'one').map(argumentName)).toEqual(['id', '#1', '#2']);
  });

  it('finds the argument a pipe call runs on from its type and data', () => {
    const pipe = new UpperPipe();
    expect(argumentOf(C, 'one', { type: 'param', data: undefined }, pipe)?.index).toBe(1);
    expect(argumentOf(C, 'one', { type: 'query', data: undefined }, pipe)?.index).toBe(2);
    expect(argumentOf(C, 'one', { type: 'body', data: undefined }, pipe)).toBeUndefined();
  });

  it("tells same-typed arguments apart by their own pipes, and gives up when it can't", () => {
    expect(argumentOf(C, 'two', { type: 'body' }, new UpperPipe())?.index).toBe(0);
    expect(argumentOf(C, 'two', { type: 'body' }, new ParseIntPipe())).toBeUndefined();
  });
});
