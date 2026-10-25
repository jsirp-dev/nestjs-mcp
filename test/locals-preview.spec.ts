import {
  captureFrames,
  isRethrow,
  truncate,
  type CallFrame,
  type CaptureInput,
  type LocalsBounds,
  type PropertyDescriptor,
  type RemoteObject,
} from '../src/debug/locals-preview.js';

const BOUNDS: LocalsBounds = {
  frames: 5,
  depth: 2,
  properties: 20,
  stringLength: 200,
  bytes: 16384,
};

/** A fake session: objects by id, each with its own properties. */
function session(objects: Record<string, PropertyDescriptor[]>) {
  const asked: string[] = [];
  return {
    asked,
    getProperties: async (objectId: string) => {
      asked.push(objectId);
      return objects[objectId] ?? [];
    },
  };
}

const prop = (name: string, value: RemoteObject, extra: Partial<PropertyDescriptor> = {}) => ({
  name,
  value,
  enumerable: true,
  isOwn: true,
  ...extra,
});

function frame(scopes: CallFrame['scopeChain'], name = 'handler', scriptId = 'app'): CallFrame {
  return {
    functionName: name,
    location: { scriptId, lineNumber: 9, columnNumber: 4 },
    scopeChain: scopes,
  };
}

function input(
  callFrames: CallFrame[],
  getProperties: CaptureInput['getProperties'],
  bounds = BOUNDS,
) {
  return {
    callFrames,
    fileOf: (id: string) => (id === 'app' ? '/app/src/cats.ts' : '/app/node_modules/x/index.js'),
    isApp: (file: string | undefined) => file !== undefined && !file.includes('node_modules'),
    getProperties,
    bounds,
    timeoutMs: 1000,
  };
}

describe('locals preview', () => {
  it('previews every kind of value without entering what it must not', async () => {
    const fake = session({
      scope: [
        prop('nothing', { type: 'undefined' }),
        prop('notANumber', { type: 'number', unserializableValue: 'NaN' }),
        prop('big', { type: 'bigint', unserializableValue: '42n' }),
        prop('sym', { type: 'symbol', description: 'Symbol(tag)' }),
        prop('fn', {
          type: 'function',
          className: 'Function',
          description: 'function find(id) { return secret; }',
        }),
        prop('arrow', { type: 'function', className: 'Function', description: '(x) => x * 2' }),
        prop('klass', {
          type: 'function',
          className: 'Function',
          description: 'class Cat { #secret = 1 }',
        }),
        prop('empty', { type: 'object', subtype: 'null' }),
        prop('map', { type: 'object', subtype: 'map', description: 'Map(2)', objectId: 'map' }),
        prop('when', {
          type: 'object',
          subtype: 'date',
          description: 'Sun Oct 25 2026 10:00:00 GMT',
        }),
        prop('failure', {
          type: 'object',
          subtype: 'error',
          description: 'Error: boom\n    at x (/a.js:1:1)',
        }),
        prop('cat', { type: 'object', className: 'Cat', objectId: 'cat' }),
        prop('list', {
          type: 'object',
          subtype: 'array',
          description: 'Array(2)',
          objectId: 'list',
        }),
        prop('.internal', { type: 'number', value: 1 }),
      ],
      cat: [
        prop('name', { type: 'string', value: 'Tom' }),
        prop('hidden', { type: 'string', value: 'no' }, { enumerable: false }),
        prop('inherited', { type: 'string', value: 'no' }, { isOwn: false }),
        {
          name: 'age',
          get: { type: 'function' },
          set: { type: 'undefined' },
          enumerable: true,
          isOwn: true,
        },
      ],
      list: [
        prop('0', { type: 'number', value: 1 }),
        prop('1', { type: 'boolean', value: true }),
        prop('length', { type: 'number', value: 2 }, { enumerable: false }),
      ],
    });
    const { frames } = await captureFrames(
      input(
        [frame([{ type: 'local', object: { type: 'object', objectId: 'scope' } }])],
        fake.getProperties,
      ),
    );
    expect(frames[0]!.scopes!.local).toEqual({
      nothing: '[undefined]',
      notANumber: '[NaN]',
      big: '[42n]',
      sym: '[Symbol(tag)]',
      fn: '[Function: find]',
      arrow: '[Function]',
      klass: '[class Cat]',
      empty: null,
      map: '[Map(2)]',
      when: '[Sun Oct 25 2026 10:00:00 GMT]',
      failure: '[Error: boom]',
      cat: { '[[Class]]': 'Cat', name: 'Tom', age: '[Getter]' },
      list: [1, true],
    });
    // A Map is described, never entered; no function's source is kept.
    expect(fake.asked).not.toContain('map');
    expect(JSON.stringify(frames)).not.toContain('secret');
  });

  it('reads local, block, catch and closure scopes, never script, module or global', async () => {
    const one = (name: string) => [prop(name, { type: 'number', value: 1 })];
    const fake = session({
      l: one('a'),
      b: one('b'),
      c: one('c'),
      cl: one('d'),
      s: one('e'),
      m: one('f'),
      g: one('g'),
    });
    const scopes = [
      'block:b',
      'local:l',
      'catch:c',
      'closure:cl',
      'script:s',
      'module:m',
      'global:g',
    ].map((entry) => {
      const [type, objectId] = entry.split(':') as [string, string];
      return { type, object: { type: 'object', objectId } };
    });
    const { frames } = await captureFrames(input([frame(scopes)], fake.getProperties));
    expect(frames[0]!.scopes).toEqual({ local: { b: 1, a: 1, c: 1 }, closure: { d: 1 } });
    expect(fake.asked.sort()).toEqual(['b', 'c', 'cl', 'l']);
  });

  it('lists frames that are not the app without reading them, up to `frames`', async () => {
    const fake = session({ x: [prop('v', { type: 'number', value: 1 })] });
    const scope = [{ type: 'local', object: { type: 'object', objectId: 'x' } }];
    const frames = [frame(scope), frame(scope, '', 'lib'), frame(scope), frame(scope)];
    const captured = await captureFrames(
      input(frames, fake.getProperties, { ...BOUNDS, frames: 3 }),
    );
    expect(captured.frames.map((f) => [f.function, f.external ?? false, f.line, f.column])).toEqual(
      [
        ['handler', false, 10, 5],
        ['<anonymous>', true, 10, 5],
        ['handler', false, 10, 5],
      ],
    );
    expect(captured.frames[1]!.scopes).toBeUndefined();
    expect(fake.asked).toEqual(['x', 'x']);
  });

  it('limits properties per object and items per array, saying how many were left', async () => {
    const many = Array.from({ length: 25 }, (_, i) => prop(`p${i}`, { type: 'number', value: i }));
    const items = Array.from({ length: 30 }, (_, i) =>
      prop(String(i), { type: 'number', value: i }),
    );
    const fake = session({
      scope: [
        prop('wide', { type: 'object', className: 'Object', objectId: 'wide' }),
        prop('long', {
          type: 'object',
          subtype: 'array',
          description: 'Array(30)',
          objectId: 'long',
        }),
      ],
      wide: many,
      long: items,
    });
    const { frames } = await captureFrames(
      input(
        [frame([{ type: 'local', object: { type: 'object', objectId: 'scope' } }])],
        fake.getProperties,
      ),
    );
    const { wide, long } = frames[0]!.scopes!.local as unknown as {
      wide: Record<string, unknown>;
      long: unknown[];
    };
    expect(Object.keys(wide)).toHaveLength(21);
    expect(wide['…']).toBe('[5 more]');
    expect(long).toHaveLength(21);
    expect(long[20]).toBe('[… 10 more]');
  });

  it('stops reading when the byte budget runs out, and stays within it', async () => {
    const fake = session({
      scope: Array.from({ length: 20 }, (_, i) =>
        prop(`s${i}`, { type: 'string', value: 'y'.repeat(150) }),
      ),
    });
    const bounds = { ...BOUNDS, bytes: 1000 };
    const captured = await captureFrames(
      input(
        [frame([{ type: 'local', object: { type: 'object', objectId: 'scope' } }])],
        fake.getProperties,
        bounds,
      ),
    );
    expect(captured.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(captured.frames))).toBeLessThanOrEqual(1000);
    expect(captured.frames[0]!.scopes!.local['…']).toBe('[…]');
  });

  it('truncates strings, saying their length', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 3)).toBe('abc…[8 chars]');
  });

  it("tells a rethrow from a catch block by the caught error's stack text", async () => {
    const fake = session({
      c: [prop('error', { type: 'object', subtype: 'error', description: 'Error: x\n    at f' })],
    });
    const top = frame([{ type: 'catch', object: { type: 'object', objectId: 'c' } }]);
    await expect(isRethrow(top, 'Error: x\n    at f', fake.getProperties)).resolves.toBe(true);
    await expect(isRethrow(top, 'Error: y\n    at f', fake.getProperties)).resolves.toBe(false);
    await expect(isRethrow(frame([]), 'Error: x\n    at f', fake.getProperties)).resolves.toBe(
      false,
    );
  });
});
