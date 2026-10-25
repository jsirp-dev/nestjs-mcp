import type { IncomingMessage } from 'node:http';
import type { ConfigurableModuleAsyncOptions } from '@nestjs/common';
import {
  DEFAULT_ID_HEADER,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_LOGS_BUFFER_SIZE,
  DEFAULT_REQUESTS_BUFFER_SIZE,
  DEFAULT_RUNS_BUFFER_SIZE,
} from './constants.js';
import { isLogSink, type LogSink } from './logs/log-sink.js';
import type { LogNormalizer } from './logs/normalize.js';
import { hostPackageInfo } from './support/package-info.js';

/** What an instance observes: the whole app (`forRoot`) or a module closure (`forFeature`). */
export type InstanceScopeKind = 'app' | 'module';

/** The tool groups with a switch. `app` is always on. */
export type SwitchableToolGroup =
  'graph' | 'routes' | 'logs' | 'requests' | 'events' | 'schedule' | 'runs';

export type ToolGroup = 'app' | SwitchableToolGroup;

export const SWITCHABLE_TOOL_GROUPS: readonly SwitchableToolGroup[] = [
  'graph',
  'routes',
  'logs',
  'requests',
  'events',
  'schedule',
  'runs',
];

/** Which request headers a trace keeps. Bodies are never kept. */
export type RequestHeadersMode = 'none' | 'names' | 'full';

/** Where the inspector's own listener binds. */
export interface NestMcpListenOptions {
  /** Default `'127.0.0.1'`: loopback only. */
  host?: string;
  /** Default `7777`; `0` picks a free port (the bootstrap log and `app_info` say which). */
  port?: number;
}

/**
 * Which logs the buffer receives: Nest's `Logger` through the tee, the host's logger through
 * `logs.sink`, or both. `'sink'` avoids duplicates when Nest's `Logger` writes through that logger.
 */
export type LogCapture = 'nest' | 'sink' | 'both';

export interface NestMcpLogsOptions {
  /** Default `2000`. */
  bufferSize?: number;
  /** From `createLogSink()`, added to the host logger's outputs: that logger's lines enter the buffer. */
  sink?: LogSink;
  /** Default `'both'`. `'sink'` requires `sink`; `'nest'` ignores it. */
  capture?: LogCapture;
  /** Maps the sink's records of a format the built-in mapping does not read. */
  normalize?: LogNormalizer;
}

/** Access control over the raw request on the listener; `false` (or a throw) answers 403. */
export type NestMcpAuthorize = (req: IncomingMessage) => boolean | Promise<boolean>;

export interface NestMcpOptions {
  /** The switch. Off, the instance registers nothing. Default: `NODE_ENV !== 'production'`. */
  enabled?: boolean;
  /** Route on the listener. Default `/` for `forRoot`; required for `forFeature`. */
  path?: string;
  /**
   * The inspector's own HTTP listener, shared by every instance of the app. Default
   * `{ host: '127.0.0.1', port: 7777 }`. Set it on one instance, or the same on all.
   */
  listen?: NestMcpListenOptions;
  /** Checked on every request to this instance's endpoint before it is answered. */
  authorize?: NestMcpAuthorize;
  /** One switch per tool group. All `true` by default. */
  tools?: Partial<Record<SwitchableToolGroup, boolean>>;
  /**
   * The ring buffer `logs_tail` reads and what fills it. The tee is process-wide and the buffer
   * shared, so give every instance with the `logs` group on the same `logs`.
   */
  logs?: NestMcpLogsOptions;
  requests?: { bufferSize?: number; idHeader?: string; headers?: RequestHeadersMode };
  /**
   * The ring buffer of job and listener runs (`runs_list`). Shared by every instance of the app:
   * the first instance that installs it sets its size. Default `{ bufferSize: 500 }`.
   */
  runs?: { bufferSize?: number };
  /** What the server reports in `initialize`. Default: the app's `package.json`. */
  serverInfo?: { name?: string; version?: string };
}

/** `forFeature` options: like `forRoot`, but `path` is required. */
export type NestMcpFeatureOptions = NestMcpOptions & { path: string };

/**
 * The options known when the module is defined: `path` (checked there, so a `forFeature` without
 * it fails at once) and, optionally, `enabled`, which then decides whether anything is registered.
 */
export type NestMcpStaticOptions = Pick<NestMcpOptions, 'enabled' | 'path'>;

/** What an async factory may return: everything but `path` (`enabled` included). */
export type NestMcpFactoryOptions = Omit<NestMcpOptions, 'path'>;

export type NestMcpAsyncOptions = ConfigurableModuleAsyncOptions<NestMcpFactoryOptions> &
  NestMcpStaticOptions;

export type NestMcpFeatureAsyncOptions = NestMcpAsyncOptions & { path: string };

export interface ResolvedNestMcpOptions {
  enabled: boolean;
  /** Normalised: no leading or trailing slashes; `''` is the listener's root. */
  path: string;
  /** As given; `undefined` takes another instance's or the default. */
  listen: Required<NestMcpListenOptions> | undefined;
  authorize: NestMcpAuthorize | undefined;
  scope: InstanceScopeKind;
  tools: Record<SwitchableToolGroup, boolean>;
  logs: {
    bufferSize: number;
    capture: LogCapture;
    sink: LogSink | undefined;
    normalize: LogNormalizer | undefined;
  };
  requests: { bufferSize: number; idHeader: string; headers: RequestHeadersMode };
  runs: { bufferSize: number };
  serverInfo: { name: string; version: string };
}

/** The default of `enabled`: the only `process.env` the package reads. */
export function defaultEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** `path` without leading or trailing slashes. */
export function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * The endpoint path with no leading or trailing slashes; `''` is the listener's root, the default
 * of `forRoot`. `forFeature` has no default: the importing module is not known when its decorator
 * argument is evaluated.
 */
export function resolvePath(path: string | undefined, scope: InstanceScopeKind): string {
  if (path === undefined) {
    if (scope === 'module') {
      throw new Error(
        "NestMcpModule.forFeature requires the `path` option, for example `{ path: 'cats' }`.",
      );
    }
    return '';
  }
  if (typeof path !== 'string') {
    throw new Error('NestMcpModule: the `path` option must be a string.');
  }
  return trimSlashes(path);
}

function resolveListen(
  listen: NestMcpListenOptions | undefined,
): Required<NestMcpListenOptions> | undefined {
  if (listen === undefined) return undefined;
  const host = listen.host ?? DEFAULT_LISTEN_HOST;
  const port = listen.port ?? DEFAULT_LISTEN_PORT;
  if (typeof host !== 'string' || host === '') {
    throw new Error('NestMcpModule: `listen.host` must be a non-empty string.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `NestMcpModule: \`listen.port\` must be an integer from 0 to 65535, got ${port}.`,
    );
  }
  return { host, port };
}

function positiveInteger(value: number | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`NestMcpModule: \`${option}\` must be a positive integer, got ${value}.`);
  }
  return value;
}

const HEADER_MODES: readonly RequestHeadersMode[] = ['none', 'names', 'full'];
const LOG_CAPTURES: readonly LogCapture[] = ['nest', 'sink', 'both'];

function resolveLogs(logs: NestMcpLogsOptions | undefined): ResolvedNestMcpOptions['logs'] {
  const capture = logs?.capture ?? 'both';
  if (!LOG_CAPTURES.includes(capture)) {
    throw new Error(
      `NestMcpModule: \`logs.capture\` must be one of ${LOG_CAPTURES.join(', ')}, got ${String(capture)}.`,
    );
  }
  if (logs?.sink !== undefined && !isLogSink(logs.sink)) {
    throw new Error('NestMcpModule: `logs.sink` must be what `createLogSink()` returns.');
  }
  if (capture === 'sink' && logs?.sink === undefined) {
    throw new Error(
      "NestMcpModule: `logs.capture: 'sink'` needs `logs.sink`, the `createLogSink()` added to your logger.",
    );
  }
  if (logs?.normalize !== undefined && typeof logs.normalize !== 'function') {
    throw new Error('NestMcpModule: `logs.normalize` must be a function `(record) => entry`.');
  }
  return {
    bufferSize: positiveInteger(logs?.bufferSize, DEFAULT_LOGS_BUFFER_SIZE, 'logs.bufferSize'),
    capture,
    sink: logs?.sink,
    normalize: logs?.normalize,
  };
}

/** Every default applied, `path` normalised and the values checked. */
export function resolveOptions(
  options: NestMcpOptions = {},
  scope: InstanceScopeKind,
): ResolvedNestMcpOptions {
  if (options.authorize !== undefined && typeof options.authorize !== 'function') {
    throw new Error('NestMcpModule: `authorize` must be a function `(req) => boolean`.');
  }
  const headers = options.requests?.headers ?? 'names';
  if (!HEADER_MODES.includes(headers)) {
    throw new Error(
      `NestMcpModule: \`requests.headers\` must be one of ${HEADER_MODES.join(', ')}, got ${String(headers)}.`,
    );
  }
  const host = options.serverInfo?.name && options.serverInfo.version ? {} : hostPackageInfo();
  const tools = Object.fromEntries(
    SWITCHABLE_TOOL_GROUPS.map((group) => [group, options.tools?.[group] ?? true]),
  ) as Record<SwitchableToolGroup, boolean>;

  return {
    enabled: options.enabled ?? defaultEnabled(),
    path: resolvePath(options.path, scope),
    listen: resolveListen(options.listen),
    authorize: options.authorize,
    scope,
    tools,
    logs: resolveLogs(options.logs),
    requests: {
      bufferSize: positiveInteger(
        options.requests?.bufferSize,
        DEFAULT_REQUESTS_BUFFER_SIZE,
        'requests.bufferSize',
      ),
      idHeader: (options.requests?.idHeader ?? DEFAULT_ID_HEADER).toLowerCase(),
      headers,
    },
    runs: {
      bufferSize: positiveInteger(
        options.runs?.bufferSize,
        DEFAULT_RUNS_BUFFER_SIZE,
        'runs.bufferSize',
      ),
    },
    serverInfo: {
      name: options.serverInfo?.name ?? host.name ?? 'nestjs-app',
      version: options.serverInfo?.version ?? host.version ?? '0.0.0',
    },
  };
}
