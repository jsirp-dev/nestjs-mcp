import { readFileSync } from 'node:fs';
import { findSourceMap, SourceMap, type SourceMapPayload } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One call in an exception's stack: where it was, never what the code there says. */
export interface StackFrame {
  /**
   * As V8 names it (`CatsController.find`, `new Thing`, `async Promise.all`), `<anonymous>` without
   * one (`async <anonymous>` for an anonymous async frame).
   */
  function: string;
  /** An absolute path; a `node:` module; or what V8 writes when there is no file (`<anonymous>`). */
  file: string;
  /** 1-based. Absent when V8 gives no position. */
  line?: number;
  /** 1-based. */
  column?: number;
  /**
   * The position is in the original source: mapped by the inspector through a source map, or a
   * file that is not JavaScript (the process had mapped it already, or runs it as it is).
   */
  mapped: boolean;
  /** In `node_modules`, a `node:` internal or without a file: not the app's code. */
  external?: true;
}

/** Compiled files whose source map is cached at most; beyond it the oldest is forgotten. */
const MAX_CACHED_FILES = 1000;

const JAVASCRIPT = /\.[cm]?js$/;
const FRAME = /^\s*at (?:(.+?) \((.*)\)|(.+))$/;
const POSITION = /^(.*):(\d+):(\d+)$/;
const ASYNC = 'async ';
const URL_SCHEME = /^[a-z][a-z\d+.-]+:/i;
const MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/gm;

/**
 * The source maps of compiled files, looked up once per file: the one Node keeps when the process
 * runs with source maps (`--enable-source-maps`), or else the file's own map, which its
 * `sourceMappingURL` comment points to (a `.map` file or an inline `data:` URL). The source text
 * a map may embed (`sourcesContent`) is dropped as soon as it is read.
 */
export class SourceMaps {
  private readonly cache = new Map<string, SourceMap | null>();
  /** Compiled files whose own map the inspector has read. */
  found = 0;

  lookup(file: string): SourceMap | undefined {
    const cached = this.cache.get(file);
    if (cached !== undefined) return cached ?? undefined;
    const map = processMap(file) ?? this.read(file);
    if (this.cache.size >= MAX_CACHED_FILES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(file, map ?? null);
    return map;
  }

  private read(file: string): SourceMap | undefined {
    try {
      const code = readFileSync(file, 'utf8');
      const url = [...code.matchAll(MAPPING_URL)].pop()?.[1];
      if (url === undefined) return undefined;
      const { payload, base } = url.startsWith('data:')
        ? { payload: inlinePayload(url), base: file }
        : readPayload(url, file);
      if (!payload || !Array.isArray(payload.sources)) return undefined;
      const map = new SourceMap(resolveSources(payload, base));
      this.found += 1;
      return map;
    } catch {
      return undefined;
    }
  }
}

/** The map Node keeps for `file`, when the process applies source maps. */
function processMap(file: string): SourceMap | undefined {
  try {
    return findSourceMap(file);
  } catch {
    return undefined;
  }
}

function inlinePayload(url: string): SourceMapPayload | undefined {
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const text = meta.endsWith(';base64')
    ? Buffer.from(data, 'base64').toString('utf8')
    : decodeURIComponent(data);
  return JSON.parse(text) as SourceMapPayload;
}

function readPayload(url: string, file: string): { payload: SourceMapPayload; base: string } {
  const path = url.startsWith('file:')
    ? fileURLToPath(url)
    : resolve(dirname(file), decodeURIComponent(url));
  return { payload: JSON.parse(readFileSync(path, 'utf8')) as SourceMapPayload, base: path };
}

/**
 * The payload with its sources as absolute paths (relative to the map, under its `sourceRoot`) and
 * without `sourcesContent`.
 */
function resolveSources(payload: SourceMapPayload, mapFile: string): SourceMapPayload {
  const root = typeof payload.sourceRoot === 'string' ? payload.sourceRoot : '';
  const sources = payload.sources.map((source) => {
    const joined = `${root}${source}`;
    if (joined.startsWith('file:')) return fileURLToPath(joined);
    // Another scheme (`webpack://app/./src/main.ts`) names no file on disk: kept as written.
    if (isAbsolute(joined) || URL_SCHEME.test(joined)) return joined;
    return resolve(dirname(mapFile), joined);
  });
  return {
    version: payload.version,
    file: payload.file,
    sourceRoot: '',
    sources,
    sourcesContent: [],
    names: payload.names ?? [],
    mappings: payload.mappings,
  };
}

/**
 * The first `limit` frames of a V8 stack (`error.stack`), with original positions where a source
 * map is found. Lines that are not frames (the message) are skipped; nothing here throws.
 */
export function stackFrames(stack: string, limit: number, maps: SourceMaps): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const text of stack.split('\n')) {
    if (frames.length >= limit) break;
    const frame = parseFrame(text);
    if (frame) frames.push(mapFrame(frame, maps));
  }
  return frames;
}

function parseFrame(text: string): StackFrame | undefined {
  const match = FRAME.exec(text);
  if (!match) return undefined;
  let name = match[1] ?? '<anonymous>';
  let location = match[2] ?? match[3] ?? '';
  // `at async /app/dist/x.js:1:2`: an anonymous async frame, marked as `async Foo.bar` is.
  if (match[3]?.startsWith(ASYNC)) {
    name = `${ASYNC}<anonymous>`;
    location = match[3].slice(ASYNC.length);
  }
  // `eval at f (file:1:2), <anonymous>:3:4`: the position is the eval'd code's.
  if (location.startsWith('eval at ')) location = location.slice(location.lastIndexOf(', ') + 2);
  const position = POSITION.exec(location);
  if (!position) return { function: name, file: location, mapped: false, external: true };
  const file = toPath(position[1]!);
  const frame: StackFrame = {
    function: name,
    file,
    line: Number(position[2]),
    column: Number(position[3]),
    mapped: !JAVASCRIPT.test(file) && !file.startsWith('node:'),
  };
  if (isExternal(file)) frame.external = true;
  return frame;
}

function toPath(file: string): string {
  if (!file.startsWith('file:')) return file;
  try {
    return fileURLToPath(file);
  } catch {
    return file;
  }
}

function isExternal(file: string): boolean {
  return file.startsWith('node:') || /[\\/]node_modules[\\/]/.test(file) || !/[\\/]/.test(file);
}

/**
 * The frame at a position V8 ran (`line` and `column` 1-based), mapped to the original source when
 * a map is found, flagged `external` like a stack's frames.
 */
export function frameAt(
  name: string,
  file: string,
  line: number,
  column: number,
  maps: SourceMaps,
): StackFrame {
  const frame: StackFrame = {
    function: name,
    file,
    line,
    column,
    mapped: !JAVASCRIPT.test(file) && !file.startsWith('node:'),
  };
  if (isExternal(file)) frame.external = true;
  return mapFrame(frame, maps);
}

function mapFrame(frame: StackFrame, maps: SourceMaps): StackFrame {
  if (frame.external || frame.mapped || frame.line === undefined || frame.column === undefined) {
    return frame;
  }
  try {
    const map = maps.lookup(frame.file);
    const entry = map?.findEntry(frame.line - 1, frame.column - 1) as
      Partial<{ originalSource: string; originalLine: number; originalColumn: number }> | undefined;
    if (!entry?.originalSource || entry.originalLine === undefined) return frame;
    return {
      function: frame.function,
      file: toPath(entry.originalSource),
      line: entry.originalLine + 1,
      column: (entry.originalColumn ?? 0) + 1,
      mapped: true,
    };
  } catch {
    return frame;
  }
}
