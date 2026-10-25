import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';
import { installLogTee } from '../src/logs/install-log-tee.js';
import { LogTee, isLogTee } from '../src/logs/log-tee.js';
import { RingBuffer } from '../src/support/ring-buffer.js';
import { MemoryLogger } from './support/memory-logger.js';

const STACK = 'Error: boom\n    at Object.<anonymous> (/app/cats.service.ts:10:11)';

describe('RingBuffer', () => {
  it('numbers entries from 1 and keeps the last `size`', () => {
    const buffer = new RingBuffer<{ value: string }>(3);
    for (const value of ['a', 'b', 'c', 'd']) buffer.push({ value });
    expect(buffer.size).toBe(3);
    expect(buffer.length).toBe(3);
    expect(buffer.lastSeq).toBe(4);
    expect(buffer.last(10).map((entry) => [entry.seq, entry.value])).toEqual([
      [2, 'b'],
      [3, 'c'],
      [4, 'd'],
    ]);
    expect(buffer.last(1).map((entry) => entry.value)).toEqual(['d']);
    expect(buffer.since(2).map((entry) => entry.seq)).toEqual([3, 4]);
    expect(buffer.since(4)).toEqual([]);
    expect(buffer.since(0).map((entry) => entry.seq)).toEqual([2, 3, 4]);
  });
});

describe('LogTee', () => {
  function tee(inner: LoggerService | undefined = new MemoryLogger()) {
    return new LogTee(inner, new RingBuffer(10));
  }

  it('forwards every call untouched and records level, context and message', () => {
    const inner = new MemoryLogger();
    const logs = tee(inner);
    logs.log('hello', 'CatsService');
    logs.warn({ id: 1 }, 'CatsService');
    logs.debug('no context');
    logs.verbose('two', 'parts', 'Ctx');
    logs.fatal('down', 'Ctx');

    expect(inner.calls).toEqual([
      { method: 'log', args: ['hello', 'CatsService'] },
      { method: 'warn', args: [{ id: 1 }, 'CatsService'] },
      { method: 'debug', args: ['no context'] },
      { method: 'verbose', args: ['two', 'parts', 'Ctx'] },
      { method: 'fatal', args: ['down', 'Ctx'] },
    ]);
    expect(
      logs.buffer.last(10).map(({ level, context, message }) => ({ level, context, message })),
    ).toEqual([
      { level: 'log', context: 'CatsService', message: 'hello' },
      { level: 'warn', context: 'CatsService', message: '{"id":1}' },
      { level: 'debug', context: null, message: 'no context' },
      { level: 'verbose', context: 'Ctx', message: 'two\nparts' },
      { level: 'fatal', context: 'Ctx', message: 'down' },
    ]);
    expect(logs.buffer.last(1)[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('splits stack and context in error as ConsoleLogger does', () => {
    const logs = tee();
    logs.error('failed', STACK, 'CatsService');
    logs.error('failed', STACK);
    logs.error('failed', 'CatsService');
    logs.error('failed', undefined, 'CatsService');
    logs.error(new Error('thrown'));
    expect(
      logs.buffer.last(10).map(({ context, message, stack }) => [context, message, stack]),
    ).toEqual([
      ['CatsService', 'failed', STACK],
      [null, 'failed', STACK],
      ['CatsService', 'failed', undefined],
      ['CatsService', 'failed', undefined],
      [null, 'thrown', expect.stringContaining('Error: thrown')],
    ]);
  });

  it('caps serialised objects at 2000 characters', () => {
    const logs = tee();
    logs.log({ big: 'x'.repeat(5000) });
    expect(logs.buffer.last(1)[0]!.message.length).toBe(2000);
  });

  it('delegates only what the inner logger has, and skips the levels it reports as disabled', () => {
    const partial = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const logs = tee(partial);
    logs.debug('quiet');
    logs.fatal('down');
    logs.setLogLevels(['error']);
    expect(logs.buffer.length).toBe(2);
    expect(logs.levels()).toBeNull();

    const console = new ConsoleLogger('Ctx', { logLevels: ['warn', 'error'] });
    const filtered = tee(console);
    filtered.log('dropped');
    filtered.debug('dropped');
    expect(filtered.buffer.length).toBe(0);
    expect(filtered.levels()).toEqual(['warn', 'error', 'fatal']);
    filtered.setLogLevels(['log']);
    expect(filtered.levels()).toEqual(['log', 'warn', 'error', 'fatal']);
  });

  it('records without forwarding when the app disabled logging', () => {
    const logs = tee(undefined);
    expect(() => logs.warn('nobody listens', 'Ctx')).not.toThrow();
    expect(logs.buffer.length).toBe(1);
  });
});

describe('installLogTee', () => {
  const original = (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
  afterEach(() => Logger.overrideLogger(original ?? false));

  it('wraps the active logger once, and Nest Logger calls go through it', () => {
    const inner = new MemoryLogger();
    Logger.overrideLogger(inner);
    const first = installLogTee(5);
    const second = installLogTee(99);
    expect(second).toBe(first);
    expect(first.buffer.size).toBe(5);
    expect(isLogTee(first)).toBe(true);

    new Logger('CatsService').warn('careful');
    new Logger('CatsService').error('failed');
    expect(inner.calls).toEqual([
      { method: 'warn', args: ['careful', 'CatsService'] },
      { method: 'error', args: ['failed', undefined, 'CatsService'] },
    ]);
    expect(first.buffer.last(10).map(({ level, context }) => [level, context])).toEqual([
      ['warn', 'CatsService'],
      ['error', 'CatsService'],
    ]);
  });

  it('wraps a fresh tee when the app replaced the logger', () => {
    Logger.overrideLogger(new MemoryLogger());
    const first = installLogTee(5);
    Logger.overrideLogger(new MemoryLogger());
    expect(installLogTee(3)).not.toBe(first);
  });

  it('wraps a ConsoleLogger when the active logger is a plain Nest Logger', () => {
    Logger.overrideLogger(new Logger());
    const logs = installLogTee(5);
    expect(logs.inner).toBeInstanceOf(ConsoleLogger);
  });
});
