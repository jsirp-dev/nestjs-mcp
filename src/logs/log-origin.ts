import { current } from '../requests/trace-context.js';
import type { RingBuffer } from '../support/ring-buffer.js';
import type { LogEntry, LogRecord } from './model.js';

/**
 * What an entry was written in: the id it carries and the object that owns it (the trace record),
 * so two requests that share an id (a client reusing the correlation header) stay apart.
 */
export interface LogOrigin {
  requestId: string;
  owner: object;
}

/**
 * Keeps the owner on the entry without showing it: symbol keys survive the buffer's spread and are
 * left out of the JSON a tool answers.
 */
const OWNER = Symbol.for('@jsirp/nestjs-mcp/log-owner');

/** Per buffer, the `seq` of the first entry each owner wrote to it. */
const firstSeqs = new WeakMap<RingBuffer<LogRecord>, WeakMap<object, number>>();

/**
 * The origin of a line written now: the request traced in this async context, if any. Read at the
 * moment the tee or the sink receives the line, with the same lookup the trace's own steps use.
 */
export function currentOrigin(): LogOrigin | undefined {
  const active = current();
  return active ? { requestId: active.trace.id, owner: active.trace } : undefined;
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
  const owned: LogRecord & { [OWNER]: object } = {
    ...record,
    requestId: origin.requestId,
    [OWNER]: origin.owner,
  };
  const entry = buffer.push(owned);
  let owners = firstSeqs.get(buffer);
  if (!owners) {
    owners = new WeakMap();
    firstSeqs.set(buffer, owners);
  }
  if (!owners.has(origin.owner)) owners.set(origin.owner, entry.seq);
}

/** The entries `owner` wrote that `buffer` still holds, oldest first. */
export interface OwnedLogs {
  entries: LogEntry[];
  /** The buffer already discarded some of them. */
  dropped: boolean;
}

export function logsOf(buffer: RingBuffer<LogRecord>, owner: object): OwnedLogs {
  const held = buffer.all();
  const entries = held.filter((entry) => (entry as { [OWNER]?: object })[OWNER] === owner);
  const first = firstSeqs.get(buffer)?.get(owner);
  const oldest = held[0]?.seq ?? buffer.lastSeq + 1;
  return { entries, dropped: first !== undefined && first < oldest };
}
