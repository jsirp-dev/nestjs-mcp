import type { ResolvedDebugOptions } from '../nest-mcp.options.js';
import { SourceMaps, stackFrames, type StackFrame } from './stack-frames.js';

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
}

/** One instance's hold on the process-wide `debug`; the last release turns it off again. */
export interface DebugHandle {
  release(): void;
}

const OFF: ResolvedDebugOptions = { enabled: false, stackFrames: 0 };

/** The first instance's `debug`, while any instance holds it. */
let active: ResolvedDebugOptions | undefined;
let holders = 0;
let maps = new SourceMaps();

/**
 * Joins the process-wide `debug`: the first instance sets it, every later one keeps it as it is
 * (like `logs`), and it is cleared when the last one releases it, so an app created after another
 * closed in the same process decides afresh.
 */
export function installDebug(options: ResolvedDebugOptions): DebugHandle {
  if (holders === 0) {
    active = { ...options };
    maps = new SourceMaps();
  }
  holders += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders === 0) active = undefined;
    },
  };
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
  };
}

/**
 * The stack of `error` as frames, when `debug` is on and it is an `Error` with a stack. Reads
 * `error.stack` (which formats it, through the process's own `Error.prepareStackTrace` if any)
 * and source maps; never throws.
 */
export function stackOf(error: unknown): StackFrame[] | undefined {
  const options = active ?? OFF;
  if (!options.enabled || !(error instanceof Error)) return undefined;
  try {
    const { stack } = error;
    return typeof stack === 'string' ? stackFrames(stack, options.stackFrames, maps) : undefined;
  } catch {
    return undefined;
  }
}
