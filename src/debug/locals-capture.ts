import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from 'node:worker_threads';
import type { ResolvedLocalsOptions } from '../nest-mcp.options.js';
import type { Capture, LocalsBounds } from './locals-preview.js';
import type { LocalsMessage, LocalsStatusMessage, LocalsWorkerData } from './locals-worker.js';

/**
 * Traces and runs in flight, in memory the locals worker reads while the main thread is paused:
 * it reads nothing when this is zero. Kept whether or not a worker runs, so the count stays right
 * across installs.
 */
const inFlight = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** A trace or a run started: exceptions from now on may be read. */
export function enterInFlight(): void {
  Atomics.add(inFlight, 0, 1);
}

/** The trace or run that called `enterInFlight` ended. */
export function leaveInFlight(): void {
  Atomics.sub(inFlight, 0, 1);
}

/** A capture nobody claimed is dropped after this long. */
const PENDING_MS = 5_000;
/** Captures waiting to be claimed, at most. */
const MAX_PENDING = 64;
/** How long the app's bootstrap waits for the session to be armed. */
export const READY_TIMEOUT_MS = 5_000;

export type LocalsState = 'starting' | 'ready' | 'failed';

/** What an error gets from the capture of its throw. */
export type LocalsClaim = Capture | { skipped: 'rate' | 'ambiguous' };

interface Pending {
  at: number;
  claim: LocalsClaim;
}

/** The worker file next to the running bundle, in its format (`.cjs` or `.js`). */
function workerFile(): string {
  return join(dirname(__filename), `locals-worker${extname(__filename)}`);
}

/**
 * The main thread's half of `debug.locals` (ADR-0005): starts the worker, collects what it posts
 * and hands each error the capture of its own throw, matched by stack text.
 */
export class LocalsCapture {
  state: LocalsState = 'starting';
  error: string | undefined;
  /** Captures and rate skips received from the worker. */
  captured = 0;
  skipped = 0;
  readonly ready: Promise<void>;

  private readonly worker: Worker | undefined;
  private readonly port: MessagePort | undefined;
  private readonly pending = new Map<string, Pending[]>();
  private readonly claimed = new WeakMap<Error, LocalsClaim>();
  private stopped = false;

  constructor(options: ResolvedLocalsOptions) {
    let settle!: () => void;
    this.ready = new Promise<void>((resolve) => (settle = resolve));
    const fail = (reason: string) => {
      if (this.stopped) return;
      this.state = 'failed';
      this.error ??= reason;
      settle();
    };
    const file = workerFile();
    if (!existsSync(file)) {
      fail(`the worker file ${file} is missing`);
      return;
    }
    const bounds: LocalsBounds = {
      frames: options.frames,
      depth: options.depth,
      properties: options.properties,
      stringLength: options.stringLength,
      bytes: options.bytes,
    };
    const channel = new MessageChannel();
    const data: LocalsWorkerData = {
      inFlight,
      port: channel.port2,
      ownDir: dirname(__filename),
      bounds,
      perMinute: options.perMinute,
    };
    try {
      this.worker = new Worker(file, {
        workerData: data,
        transferList: [channel.port2],
        // No preload hooks of the app (`-r`, `--import`) in the worker: it runs only this file.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
    } catch (error) {
      channel.port1.close();
      fail(String(error));
      return;
    }
    this.port = channel.port1;
    this.port.on('message', (message: LocalsMessage) => this.accept(message));
    this.port.unref();
    this.worker.unref();
    this.worker.on('message', (message: LocalsStatusMessage) => {
      if ('ready' in message) {
        this.state = 'ready';
        settle();
      } else {
        fail(message.failed);
      }
    });
    this.worker.on('error', (error) => fail(String(error)));
    this.worker.on('exit', (code) => {
      if (!this.stopped) fail(`the worker exited with code ${code}`);
    });
  }

  /**
   * The capture of `error`'s throw: the one pending under its stack text, kept with the error
   * from then on. Several pending under the same text are another request's as likely as this
   * one's: none is taken (`ambiguous`).
   */
  claim(error: Error, stack: string): LocalsClaim | undefined {
    const known = this.claimed.get(error);
    if (known) return known;
    this.drain();
    const now = Date.now();
    const waiting = this.pending.get(stack)?.filter((entry) => now - entry.at < PENDING_MS);
    this.pending.delete(stack);
    if (!waiting || waiting.length === 0) return undefined;
    const claim: LocalsClaim = waiting.length === 1 ? waiting[0]!.claim : { skipped: 'ambiguous' };
    this.claimed.set(error, claim);
    return claim;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.port?.close();
    await this.worker?.terminate();
  }

  /** What the worker posted and the event loop has not delivered yet. */
  private drain(): void {
    if (!this.port) return;
    for (let next = receiveMessageOnPort(this.port); next; next = receiveMessageOnPort(this.port)) {
      this.accept(next.message as LocalsMessage);
    }
  }

  private accept(message: LocalsMessage): void {
    const claim: LocalsClaim =
      'skipped' in message
        ? { skipped: message.skipped }
        : message.truncated
          ? { frames: message.frames, truncated: true }
          : { frames: message.frames };
    if ('skipped' in claim) this.skipped += 1;
    else this.captured += 1;
    // Only whether one or several are pending matters: the two latest are enough to tell.
    const list = (this.pending.get(message.key) ?? []).slice(-1);
    list.push({ at: Date.now(), claim });
    this.pending.delete(message.key);
    this.pending.set(message.key, list);
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }
}
