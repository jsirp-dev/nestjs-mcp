import type { ResolvedDebugOptions } from '../nest-mcp.options.js';
import { LocalsCapture, READY_TIMEOUT_MS, type LocalsState } from './locals-capture.js';
import type { CapturedFrame, LocalScopes } from './locals-preview.js';
import { frameAt, SourceMaps, stackFrames, type StackFrame } from './stack-frames.js';

/** What `app_info` says of `debug`: the process-wide value and how stacks are mapped. */
export interface DebugStatus {
  enabled: boolean;
  stackFrames: number;
  sourceMaps: {
    /** Node maps stacks itself (`--enable-source-maps` or `process.setSourceMapsEnabled(true)`). */
    process: boolean;
    /** Compiled files whose own source map the inspector has read so far. */
    files: number;
  };
  /** Local variables at the throw (ADR-0005). */
  locals: {
    /** `off` with `debug` or `debug.locals` off: no worker, no inspector session. */
    state: 'off' | LocalsState;
    /** Why the worker could not start, when it failed. */
    error?: string;
    /** Captures the worker read, and errors it skipped for the rate, since it started. */
    captured: number;
    skippedRate: number;
  };
}

/** One frame of `locals`, aligned with the error's `stack`: where it is and what its scopes held. */
export interface FrameLocals {
  function: string;
  file: string;
  line?: number;
  /** Not the app's code: its scopes were not read. */
  external?: true;
  scopes?: LocalScopes;
}

/** The debugging data `debug` adds to a recorded error. */
export interface ErrorDebugData {
  stack?: StackFrame[];
  locals?: FrameLocals[];
  /** The byte budget (or the time limit) ran out before every frame was read. */
  localsTruncated?: true;
  /** No locals: beyond the per-minute rate, or two pending captures could have been this one. */
  localsSkipped?: 'rate' | 'ambiguous';
}

/** One instance's hold on the process-wide `debug`; the last release turns it off again. */
export interface DebugHandle {
  /** Resolves once the locals worker is armed (or failed, or is off), at most a few seconds on. */
  ready(): Promise<void>;
  release(): Promise<void>;
}

const OFF: ResolvedDebugOptions = {
  enabled: false,
  stackFrames: 0,
  locals: {
    enabled: false,
    frames: 0,
    depth: 0,
    properties: 0,
    stringLength: 0,
    bytes: 0,
    perMinute: 0,
  },
};

/** The first instance's `debug`, while any instance holds it. */
let active: ResolvedDebugOptions | undefined;
let holders = 0;
let maps = new SourceMaps();
let capture: LocalsCapture | undefined;
let failureTaken: LocalsCapture | undefined;
/**
 * The `locals` of each capture, built once: every step that records the same exception holds the
 * same array, which is how `request_trace` shows it on the first of them only.
 */
const aligned = new WeakMap<object, FrameLocals[]>();

/**
 * Joins the process-wide `debug`: the first instance sets it, every later one keeps it as it is
 * (like `logs`), and it is cleared when the last one releases it, so an app created after another
 * closed in the same process decides afresh. The first one with `debug.locals` on starts the
 * locals worker; the last release stops it.
 */
export function installDebug(options: ResolvedDebugOptions): DebugHandle {
  if (holders === 0) {
    active = { ...options, locals: { ...options.locals } };
    maps = new SourceMaps();
    capture =
      options.enabled && options.locals.enabled ? new LocalsCapture(options.locals) : undefined;
  }
  holders += 1;
  const mine = capture;
  let released = false;
  return {
    async ready() {
      if (!mine) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        mine.ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, READY_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
    async release() {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders > 0) return;
      active = undefined;
      const stopping = capture;
      capture = undefined;
      await stopping?.stop();
    },
  };
}

/**
 * Why the locals worker could not start, the first time it is asked after a failure (so each
 * failed worker is warned about once, whatever the number of instances); `undefined` otherwise.
 */
export function takeLocalsFailure(): string | undefined {
  if (capture?.state !== 'failed' || failureTaken === capture) return undefined;
  failureTaken = capture;
  return capture.error;
}

export function debugStatus(fallback: ResolvedDebugOptions): DebugStatus {
  const options = active ?? fallback;
  return {
    enabled: options.enabled,
    stackFrames: options.stackFrames,
    sourceMaps: {
      process: (process as { sourceMapsEnabled?: boolean }).sourceMapsEnabled === true,
      files: maps.found,
    },
    locals: {
      state: capture?.state ?? 'off',
      ...(capture?.error !== undefined ? { error: capture.error } : {}),
      captured: capture?.captured ?? 0,
      skippedRate: capture?.skipped ?? 0,
    },
  };
}

/**
 * The debugging data of `error`, when `debug` is on and it is an `Error` with a stack: its frames
 * (reading `error.stack`, which formats it through the process's own `Error.prepareStackTrace` if
 * any, and source maps) and, with `debug.locals`, the locals captured at its throw. Never throws.
 */
export function debugOf(error: unknown): ErrorDebugData {
  const options = active ?? OFF;
  if (!options.enabled || !(error instanceof Error)) return {};
  try {
    const { stack } = error;
    if (typeof stack !== 'string') return {};
    const frames = stackFrames(stack, options.stackFrames, maps);
    const claim = capture?.claim(error, stack);
    if (!claim) return { stack: frames };
    if ('skipped' in claim) return { stack: frames, localsSkipped: claim.skipped };
    let locals = aligned.get(claim);
    if (!locals) {
      locals = claim.frames.map((captured, index) => align(captured, frames[index]));
      aligned.set(claim, locals);
    }
    return claim.truncated
      ? { stack: frames, locals, localsTruncated: true }
      : { stack: frames, locals };
  } catch {
    return {};
  }
}

/** Whether the stack's frame names the function the worker paused in (`Cats.find` and `find`). */
function sameFunction(inStack: string, captured: string): boolean {
  const name = inStack.replace(/^(?:async |new )/, '');
  return name === captured || name.endsWith(`.${captured}`);
}

/**
 * A captured frame where the stack's frame at the same index is, when both name the same
 * function (the error was created where it was thrown, as usual): the stack's position is
 * already mapped. Otherwise its own position, mapped the same way.
 */
function align(captured: CapturedFrame, inStack: StackFrame | undefined): FrameLocals {
  const where =
    inStack && sameFunction(inStack.function, captured.function)
      ? inStack
      : frameAt(captured.function, captured.file, captured.line, captured.column, maps);
  return {
    function: where.function,
    file: where.file,
    ...(where.line !== undefined ? { line: where.line } : {}),
    ...(captured.external ? { external: true as const } : {}),
    ...(captured.scopes ? { scopes: captured.scopes } : {}),
  };
}
