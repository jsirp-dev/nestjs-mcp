import { randomUUID } from 'node:crypto';
import { enterInFlight, leaveInFlight } from '../debug/locals-capture.js';
import { performance } from 'node:perf_hooks';
import type { RequestHeadersMode } from '../nest-mcp.options.js';
import { RingBuffer } from '../support/ring-buffer.js';
import type { RequestTrace } from './model.js';
import { round, type ActiveTrace } from './trace-context.js';

/** What the recorder reads from a request. Duck-typed: Express's `Request` fits. */
export interface IncomingRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** What the recorder reads from a response. Duck-typed: Express's `Response` fits. */
export interface OutgoingResponseLike {
  statusCode: number;
  writableFinished?: boolean;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

export interface TraceRecorderOptions {
  bufferSize: number;
  /** Lower-case header name. */
  idHeader: string;
  headers: RequestHeadersMode;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * The traces of one app: a ring buffer shared by every instance mounted in it and the enhancer
 * classes that cannot be traced. The inspector's own requests never reach it: they arrive on the
 * inspector listener, not through Nest.
 */
export class TraceRecorder {
  readonly buffer: RingBuffer<{ trace: RequestTrace }>;
  /** `REQUEST` and `TRANSIENT` enhancer classes, which have no instance to wrap. */
  readonly untraced = new Set<string>();

  constructor(readonly options: TraceRecorderOptions) {
    this.buffer = new RingBuffer(options.bufferSize);
  }

  /** Every trace held, oldest first; in-flight ones included. */
  traces(): RequestTrace[] {
    return this.buffer.all().map((entry) => entry.trace);
  }

  /**
   * Opens the trace of a request and closes it when the response finishes or the connection
   * closes. Bodies are never read.
   */
  start(request: IncomingRequestLike, response: OutgoingResponseLike): ActiveTrace {
    const url = request.originalUrl ?? request.url ?? '';

    const sent = headerValue(request.headers[this.options.idHeader])?.trim();
    const trace: RequestTrace = {
      id: sent || randomUUID(),
      method: request.method ?? 'GET',
      url,
      startedAt: new Date().toISOString(),
      steps: [],
    };
    if (this.options.headers === 'names') trace.headers = Object.keys(request.headers);
    if (this.options.headers === 'full') {
      trace.headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, headerValue(value)!]),
      );
    }
    const active: ActiveTrace = { trace, t0: performance.now() };
    this.buffer.push({ trace });
    enterInFlight();

    const finish = () => {
      if (trace.durationMs !== undefined) return;
      leaveInFlight();
      trace.durationMs = round(performance.now() - active.t0);
      trace.statusCode = response.statusCode;
      if (response.writableFinished === false) trace.aborted = true;
    };
    response.once('finish', finish);
    response.once('close', finish);
    return active;
  }
}
