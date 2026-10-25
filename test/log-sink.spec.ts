import { createLogSink, isLogSink, connectLogSink, logSinkStats } from '../src/logs/log-sink.js';
import { normalizeLogLevel } from '../src/logs/normalize.js';
import type { LogRecord } from '../src/logs/model.js';
import { RingBuffer } from '../src/support/ring-buffer.js';

const STACK = 'Error: boom\n    at Object.<anonymous> (/app/cats.service.ts:10:11)';

function connected(normalize?: (record: unknown) => unknown) {
  const sink = createLogSink();
  const buffer = connectLogSink(sink, {
    buffer: undefined,
    size: 100,
    normalize: normalize as never,
  });
  const entries = () => buffer.all().map(({ seq: _seq, ...entry }) => entry);
  return { sink, buffer, entries };
}

describe('normalizeLogLevel', () => {
  it.each([
    [10, 'verbose'],
    [20, 'debug'],
    [30, 'log'],
    [35, 'log'],
    [40, 'warn'],
    [50, 'error'],
    [60, 'fatal'],
    [70, 'fatal'],
    ['trace', 'verbose'],
    ['silly', 'verbose'],
    ['verbose', 'verbose'],
    ['debug', 'debug'],
    ['info', 'log'],
    ['http', 'log'],
    ['log', 'log'],
    ['WARN', 'warn'],
    ['warning', 'warn'],
    ['error', 'error'],
    ['fatal', 'fatal'],
    ['critical', 'fatal'],
    ['\u001b[32minfo\u001b[39m', 'log'],
    ['shouting', 'log'],
    [undefined, 'log'],
  ])('maps %p to %p', (level, expected) => {
    expect(normalizeLogLevel(level)).toBe(expected);
  });
});

describe('LogSink', () => {
  it('is a writable a logger can write to, recognised across copies', () => {
    const sink = createLogSink();
    expect(typeof sink.write).toBe('function');
    expect(typeof sink.record).toBe('function');
    expect(isLogSink(sink)).toBe(true);
    expect(isLogSink({ write() {} })).toBe(false);
  });

  it('reads a pino JSON line: numeric level, msg, time and context', () => {
    const { sink, entries } = connected();
    const time = Date.UTC(2026, 9, 25, 12, 0, 0);
    sink.write(
      JSON.stringify({ level: 40, time, pid: 1, context: 'CatsService', msg: 'low on food' }) +
        '\n',
    );
    expect(entries()).toEqual([
      {
        source: 'sink',
        timestamp: new Date(time).toISOString(),
        level: 'warn',
        context: 'CatsService',
        message: 'low on food',
      },
    ]);
  });

  it('reads a pino error line with the serialised err as the stack', () => {
    const { sink, entries } = connected();
    sink.write(
      JSON.stringify({
        level: 50,
        time: 1,
        err: { type: 'Error', message: 'boom', stack: STACK },
        msg: 'it failed',
      }) + '\n',
    );
    expect(entries()[0]).toMatchObject({ level: 'error', message: 'it failed', stack: STACK });
  });

  it('reads a bunyan line: name as the context and an ISO time', () => {
    const { sink, entries } = connected();
    sink.write(
      JSON.stringify({
        name: 'billing',
        level: 30,
        time: '2026-10-25T12:00:00.000Z',
        msg: 'paid',
        v: 0,
      }) + '\n',
    );
    expect(entries()[0]).toMatchObject({
      timestamp: '2026-10-25T12:00:00.000Z',
      level: 'log',
      context: 'billing',
      message: 'paid',
    });
  });

  it('splits a chunk with several lines into one entry each', () => {
    const { sink, entries } = connected();
    sink.write('{"level":30,"msg":"one"}\n{"level":30,"msg":"two"}\n');
    expect(entries().map((entry) => entry.message)).toEqual(['one', 'two']);
  });

  it('turns plain text lines into log entries with the line as message', () => {
    const { sink, entries } = connected();
    sink.write('server started\nlistening on 3000\n\n');
    sink.write(Buffer.from('a buffer line'));
    expect(entries()).toEqual([
      expect.objectContaining({ level: 'log', context: null, message: 'server started' }),
      expect.objectContaining({ level: 'log', context: null, message: 'listening on 3000' }),
      expect.objectContaining({ level: 'log', context: null, message: 'a buffer line' }),
    ]);
  });

  it('keeps the message exactly as written: nothing is masked or altered', () => {
    const { sink, entries } = connected();
    const message = '  password=hunter2 token="abc"  \t';
    sink.write(JSON.stringify({ level: 30, msg: message }) + '\n');
    sink.record({ level: 'info', message });
    expect(entries().map((entry) => entry.message)).toEqual([message, message]);
  });

  it('records a winston-style entry: { level, message, context }', () => {
    const { sink, entries } = connected();
    sink.record({ level: 'warn', message: 'disk almost full', context: 'DiskService' });
    expect(entries()[0]).toMatchObject({
      source: 'sink',
      level: 'warn',
      context: 'DiskService',
      message: 'disk almost full',
    });
  });

  it('serialises a non-string message as JSON, capped at 2000 characters', () => {
    const { sink, entries } = connected();
    sink.record({ level: 'info', message: { cats: 3 } });
    sink.record({ level: 'info', message: 'x'.repeat(10) + JSON.stringify('y'.repeat(5000)) });
    sink.record({ level: 'info', message: ['z'.repeat(5000)] });
    const [object, , long] = entries();
    expect(object!.message).toBe('{"cats":3}');
    expect(long!.message).toHaveLength(2000);
  });

  it('lets normalize map a custom format, falling back to the built-in mapping on undefined', () => {
    const { sink, entries } = connected((record) => {
      if (typeof record === 'string') {
        const match = /^\[(\w)\] (\w+): (.*)$/.exec(record);
        if (match)
          return {
            level: match[1] === 'W' ? 'warn' : 'info',
            context: match[2],
            message: match[3],
          };
      }
      if (typeof record === 'object' && record !== null && 'severity' in record) {
        const { severity, text } = record as { severity: string; text: string };
        return { level: severity, message: text };
      }
      return undefined;
    });
    sink.write('[W] Disk: almost full\n');
    sink.write('{"severity":"ERROR","text":"disk full"}\n');
    sink.write('{"level":30,"msg":"pino as usual"}\n');
    sink.record({ level: 'debug', message: 'winston as usual' });
    expect(entries()).toEqual([
      expect.objectContaining({ level: 'warn', context: 'Disk', message: 'almost full' }),
      expect.objectContaining({ level: 'error', context: null, message: 'disk full' }),
      expect.objectContaining({ level: 'log', message: 'pino as usual' }),
      expect.objectContaining({ level: 'debug', message: 'winston as usual' }),
    ]);
  });

  it('never throws into the logger: errors are swallowed, counted and the line is kept', () => {
    const { sink, entries } = connected(() => {
      throw new Error('normalizer bug');
    });
    const circular: Record<string, unknown> = { level: 'info' };
    circular.message = circular;
    expect(() => sink.write('a line\n')).not.toThrow();
    expect(() => sink.record(circular)).not.toThrow();
    expect(() => sink.record(undefined)).not.toThrow();
    expect(() => sink.record(null)).not.toThrow();
    expect(entries().map((entry) => entry.message)).toEqual(['a line', '[object Object]', '', '']);
    expect(logSinkStats(sink)).toEqual({
      connected: true,
      received: 4,
      errors: 4,
      lastError: 'normalizer bug',
    });
  });

  it('keeps reading after end, without an error event', async () => {
    const { sink, entries } = connected();
    const errors: unknown[] = [];
    sink.on('error', (error) => errors.push(error));
    sink.end();
    await new Promise((resolve) => setImmediate(resolve));
    const done = jest.fn();
    expect(sink.write('late\n', done)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toHaveBeenCalledTimes(1);
    expect(entries().map((entry) => entry.message)).toEqual(['late']);
    expect(errors).toEqual([]);
    expect(logSinkStats(sink).errors).toBe(0);
  });

  it('holds what arrives before it is connected and delivers it on connect, with its arrival time', () => {
    const sink = createLogSink();
    sink.write('early line\n');
    sink.record({ level: 'warn', message: 'early record' });
    expect(logSinkStats(sink)).toMatchObject({ connected: false, received: 2 });

    const buffer = connectLogSink(sink, { buffer: undefined, size: 10, normalize: undefined });
    expect(buffer.all().map((entry) => entry.message)).toEqual(['early line', 'early record']);
    expect(buffer.all()[0]!.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('feeds the buffer it is given, and a later connect without one reads the same', () => {
    const sink = createLogSink();
    const shared = new RingBuffer<LogRecord>(10);
    expect(connectLogSink(sink, { buffer: shared, size: 10, normalize: undefined })).toBe(shared);
    expect(connectLogSink(sink, { buffer: undefined, size: 99, normalize: undefined })).toBe(
      shared,
    );
    sink.write('x\n');
    expect(shared.length).toBe(1);
  });
});
