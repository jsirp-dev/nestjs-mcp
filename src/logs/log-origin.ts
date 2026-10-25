import { current } from '../requests/trace-context.js';
import { currentRun } from '../runs/run-context.js';
import type { RingBuffer } from '../support/ring-buffer.js';
import type { LogEntry, LogRecord } from './model.js';

/**
 * What an entry was written in: the ids it carries and the objects that own it (the trace record,
 * the run record), so two requests that share an id (a client reusing the correlation header)
 * stay apart. A line a listener writes while it runs inside a request belongs to both.
 */
export interface LogOrigin {
  requestId?: string;
  runId?: string;
  owners: object[];
}

/**
 * Keeps the owners on the entry without showing them: symbol keys survive the buffer's spread and
 * are left out of the JSON a tool answers.
 */
const OWNERS = Symbol.for('@jsirp/nestjs-mcp/log-owners');

/** Per buffer, the `seq` of the first entry each owner wrote to it. */
const firstSeqs = new WeakMap<RingBuffer<LogRecord>, WeakMap<object, number>>();

/**
 * The origin of a line written now: the request traced and the job or listener running in this
 * async context, if any. Read at the moment the tee or the sink receives the line, with the same
 * lookups the trace's steps and the runs use.
 */
export function currentOrigin(): LogOrigin | undefined {
  const active = current();
  const run = currentRun();
  if (!active && !run) return undefined;
  const origin: LogOrigin = { owners: [] };
  if (active) {
    origin.requestId = active.trace.id;
    origin.owners.push(active.trace);
  }
  if (run) {
    origin.runId = run.id;
    origin.owners.push(run);
  }
  return origin;
}

/** Pushes `record` to `buffer`, tied to `origin` when there is one. */
export function pushLog(
  buffer: RingBuffer<LogRecord>,
  record: LogRecord,
  origin: LogOrigin | undefined,
): void {
  if (!origin) {
    buffer.push(record);
    return;
  }
  const owned: LogRecord & { [OWNERS]: object[] } = {
    ...record,
    ...(origin.requestId !== undefined ? { requestId: origin.requestId } : {}),
    ...(origin.runId !== undefined ? { runId: origin.runId } : {}),
    [OWNERS]: origin.owners,
  };
  const entry = buffer.push(owned);
  let owners = firstSeqs.get(buffer);
  if (!owners) {
    owners = new WeakMap();
    firstSeqs.set(buffer, owners);
  }
  for (const owner of origin.owners) {
    if (!owners.has(owner)) owners.set(owner, entry.seq);
  }
}

/** The entries `owner` (a trace or a run record) wrote that `buffer` still holds, oldest first. */
export interface OwnedLogs {
  entries: LogEntry[];
  /** The buffer already discarded some of them. */
  dropped: boolean;
}

export function logsOf(buffer: RingBuffer<LogRecord>, owner: object): OwnedLogs {
  const held = buffer.all();
  const entries = held.filter((entry) =>
    (entry as { [OWNERS]?: object[] })[OWNERS]?.includes(owner),
  );
  const first = firstSeqs.get(buffer)?.get(owner);
  const oldest = held[0]?.seq ?? buffer.lastSeq + 1;
  return { entries, dropped: first !== undefined && first < oldest };
}
