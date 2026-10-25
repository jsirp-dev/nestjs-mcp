import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { installEmitRecorder, type EmitterLike } from '../src/events/emit-recorder.js';
import { readListeners } from '../src/events/listeners-reader.js';
import type { EmissionRecord } from '../src/events/model.js';
import { RingBuffer } from '../src/support/ring-buffer.js';
import { CATS_INSPECTOR_PATH } from './fixtures/app/cats/cats.module.js';
import { RunningApp, StartAppOptions, startApp, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

describe('events tools', () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function boot(options: StartAppOptions = {}, path = '/'): Promise<Client> {
    running = await startApp({ events: true, ...options });
    return running.connect(path);
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { json: toolJson(result) as Json, isError: result.isError === true };
  }

  const emitter = () => running!.app.get(EventEmitter2);
  const label = (listener: Json) => `${listener.className}.${listener.methodName}`;

  describe('events_listeners', () => {
    it('lists CatsService.onCatAdopted for cat.adopted with its module and options', async () => {
      const client = await boot();
      const { json } = await call(client, 'events_listeners');
      expect(json.scope).toEqual({ kind: 'app' });
      expect(json.wildcard).toBe(false);
      const adopted = json.listeners.find(
        (listener: Json) => label(listener) === 'CatsService.onCatAdopted',
      );
      expect(adopted).toEqual({
        event: 'cat.adopted',
        className: 'CatsService',
        methodName: 'onCatAdopted',
        module: 'CatsModule',
      });
      const any = json.listeners.find(
        (listener: Json) => label(listener) === 'CatsService.onAnyCatEvent',
      );
      expect(any).toMatchObject({ event: 'cat.*', options: { async: true } });
    });

    it('filters by substring of the pattern without wildcards', async () => {
      const client = await boot();
      const { json } = await call(client, 'events_listeners', { event: 'adopted' });
      expect(json.listeners.map(label)).toEqual(['CatsService.onCatAdopted']);
    });

    it('resolves wildcard patterns through the emitter, not by string comparison', async () => {
      const client = await boot({ events: { wildcard: true } });
      const { json } = await call(client, 'events_listeners', { event: 'cat.adopted' });
      expect(json.wildcard).toBe(true);
      expect(json.listeners.map(label).sort()).toEqual([
        'CatsService.onAnyCatEvent',
        'CatsService.onCatAdopted',
      ]);
      // `cat.*` is not a substring of `cat.adopted`, and `dog.adopted` matches neither pattern.
      expect(
        (await call(client, 'events_listeners', { event: 'dog.adopted' })).json.listeners,
      ).toEqual([]);
    });

    it('a module-scoped instance lists only the listeners of classes in its scope', async () => {
      const client = await boot({ catsInspector: true, health: true }, CATS_INSPECTOR_PATH);
      const { json } = await call(client, 'events_listeners');
      expect(json.scope).toEqual({ kind: 'module', module: 'CatsModule' });
      expect(json.listeners.map(label)).not.toContain('HealthController.onAppReady');
      expect(json.listeners.map(label)).toContain('CatsService.onCatAdopted');
      const lifted = await call(client, 'events_listeners', { scope: 'app' });
      expect(lifted.json.listeners.map(label)).toContain('HealthController.onAppReady');
    });
  });

  describe('events_recent', () => {
    it('shows an emission with its listener count and no payload', async () => {
      const client = await boot();
      emitter().emit('cat.adopted', { id: 1, owner: 'secret-owner' });
      const { json } = await call(client, 'events_recent');
      expect(json.emissions).toBe('app-wide');
      expect(json.entries).toHaveLength(1);
      const [entry] = json.entries;
      expect(entry).toEqual({
        seq: 1,
        event: 'cat.adopted',
        method: 'emit',
        timestamp: expect.any(String),
        listeners: 1,
      });
      expect(JSON.stringify(json)).not.toContain('secret-owner');
    });

    it('counts wildcard listeners through the emitter', async () => {
      const client = await boot({ events: { wildcard: true } });
      await emitter().emitAsync('cat.adopted', { id: 2 });
      const { json } = await call(client, 'events_recent');
      expect(json.entries[0]).toMatchObject({
        event: 'cat.adopted',
        method: 'emitAsync',
        listeners: 2,
      });
    });

    it('filters by event and limits to the newest', async () => {
      const client = await boot({ events: { wildcard: true } });
      emitter().emit('cat.adopted', {});
      emitter().emit('app.ready');
      emitter().emit('cat.adopted', {});
      expect((await call(client, 'events_recent', { limit: 1 })).json.entries).toMatchObject([
        { seq: 3, event: 'cat.adopted' },
      ]);
      expect(
        (await call(client, 'events_recent', { event: 'app' })).json.entries.map(
          (e: Json) => e.seq,
        ),
      ).toEqual([2]);
      expect(
        (await call(client, 'events_recent', { event: 'cat.*' })).json.entries.map(
          (e: Json) => e.seq,
        ),
      ).toEqual([1, 3]);
    });

    it('two instances in one app share one recorder on the emitter', async () => {
      const root = await boot({ catsInspector: true });
      const cats = await running!.connect(CATS_INSPECTOR_PATH);
      emitter().emit('cat.adopted', {});
      expect((await call(root, 'events_recent')).json.entries).toHaveLength(1);
      expect((await call(cats, 'events_recent')).json.entries).toHaveLength(1);
    });

    it('the listener still receives the payload', async () => {
      await boot();
      const seen: unknown[] = [];
      emitter().on('cat.adopted', (payload: unknown) => seen.push(payload));
      emitter().emit('cat.adopted', { id: 7 });
      expect(seen).toEqual([{ id: 7 }]);
    });
  });

  it('app_info reports the events group live', async () => {
    const client = await boot();
    expect((await call(client, 'app_info')).json.tools.events).toBe(true);
  });

  it('an app that does not import EventEmitterModule boots with no events_* tool', async () => {
    const client = await boot({ events: false });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('app_info');
    expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('events_'))).toEqual([]);
    expect((await call(client, 'app_info')).json.tools.events).toBe(false);
  });

  it('with tools.events off, nothing is registered and emit is not wrapped', async () => {
    // The runs group wraps emit too (to know which event a listener runs for): off as well.
    const client = await boot({
      root: { kind: 'sync', options: { tools: { events: false, runs: false } } },
    });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('events_'))).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(emitter(), 'emit')).toBe(false);
  });
});

describe('installEmitRecorder', () => {
  function fakeEmitter() {
    const promise = Promise.resolve(['done']);
    const emitter = {
      emit: jest.fn((..._args: unknown[]) => false),
      emitAsync: jest.fn((..._args: unknown[]) => promise),
      listenerCount: jest.fn((_event: unknown) => 3),
    };
    return { emitter, promise };
  }

  it('emit returns exactly what it returned, with the same this and arguments', () => {
    const { emitter } = fakeEmitter();
    const original = emitter.emit;
    installEmitRecorder(emitter as unknown as EmitterLike, new RingBuffer<EmissionRecord>(10));
    const payload = { id: 1 };
    expect(emitter.emit('cat.adopted', payload, 'extra')).toBe(false);
    expect(original).toHaveBeenCalledWith('cat.adopted', payload, 'extra');
    expect(original.mock.contexts[0]).toBe(emitter);
  });

  it('emitAsync returns the same promise', () => {
    const { emitter, promise } = fakeEmitter();
    installEmitRecorder(emitter as unknown as EmitterLike, new RingBuffer<EmissionRecord>(10));
    expect(emitter.emitAsync('cat.adopted', {})).toBe(promise);
  });

  it('rethrows what emit throws, after recording it', () => {
    const buffer = new RingBuffer<EmissionRecord>(10);
    const emitter = {
      emit: (..._args: unknown[]) => {
        throw new Error('no error listener');
      },
      emitAsync: () => Promise.resolve([]),
      listenerCount: () => 0,
    };
    installEmitRecorder(emitter, buffer);
    expect(() => emitter.emit('error', new Error('x'))).toThrow('no error listener');
    expect(buffer.all()).toMatchObject([{ event: 'error', listeners: 0 }]);
  });

  it('is idempotent: a second install keeps the first buffer and wraps once', () => {
    const { emitter } = fakeEmitter();
    const first = installEmitRecorder(emitter as unknown as EmitterLike, new RingBuffer(10));
    const second = installEmitRecorder(emitter as unknown as EmitterLike, new RingBuffer(10));
    expect(second).toBe(first);
    emitter.emit('a');
    expect(first.all()).toHaveLength(1);
  });

  it('keeps the event name, method, count and time, never the payload', () => {
    const { emitter } = fakeEmitter();
    const buffer = installEmitRecorder(emitter as unknown as EmitterLike, new RingBuffer(10));
    emitter.emit(['cat', 'adopted'], { secret: 'payload' });
    expect(buffer.all()).toEqual([
      { seq: 1, event: 'cat.adopted', method: 'emit', timestamp: expect.any(String), listeners: 3 },
    ]);
  });
});

describe('readListeners', () => {
  it('lists a request-scoped class from its prototype and never runs a getter', () => {
    const getter = jest.fn(() => 'value');
    class PerRequest {
      get computed() {
        return getter();
      }
      @OnEvent(['order', 'placed'])
      onOrderPlaced(): void {}
    }
    const wrapper = {
      metatype: PerRequest,
      instance: undefined,
      isDependencyTreeStatic: () => false,
    };
    const container = {
      values: () => [
        { id: 'm1', name: 'OrdersModule', providers: new Map([[PerRequest, wrapper]]) },
      ],
    };
    expect(readListeners(container, (module) => module.name!)).toEqual([
      {
        event: ['order', 'placed'],
        className: 'PerRequest',
        methodName: 'onOrderPlaced',
        module: 'OrdersModule',
        requestScoped: true,
      },
    ]);
    expect(getter).not.toHaveBeenCalled();
  });
});
