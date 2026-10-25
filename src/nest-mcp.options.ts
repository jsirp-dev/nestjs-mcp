import type { CanActivate, Type } from '@nestjs/common';
import type { ConfigurableModuleAsyncOptions } from '@nestjs/common';
import {
  DEFAULT_ID_HEADER,
  DEFAULT_LOGS_BUFFER_SIZE,
  DEFAULT_PATH,
  DEFAULT_REQUESTS_BUFFER_SIZE,
} from './constants.js';
import { hostPackageInfo } from './support/package-info.js';

/** What an instance observes: the whole app (`forRoot`) or a module closure (`forFeature`). */
export type InstanceScopeKind = 'app' | 'module';

/** The tool groups with a switch. `app` is always on. */
export type SwitchableToolGroup = 'graph' | 'routes' | 'logs' | 'requests' | 'events' | 'schedule';

export type ToolGroup = 'app' | SwitchableToolGroup;

export const SWITCHABLE_TOOL_GROUPS: readonly SwitchableToolGroup[] = [
  'graph',
  'routes',
  'logs',
  'requests',
  'events',
  'schedule',
];

/** Which request headers a trace keeps. Bodies are never kept. */
export type RequestHeadersMode = 'none' | 'names' | 'full';

export interface NestMcpOptions {
  /** The switch. Off, the instance registers nothing. Default: `NODE_ENV !== 'production'`. */
  enabled?: boolean;
  /** Endpoint route, relative to the global prefix. Default `_mcp`; required for `forFeature`. */
  path?: string;
  /** Nest guards on the endpoint, like `@UseGuards`, after `LocalOnlyGuard`. */
  guards?: Type<CanActivate>[];
  /** Reject anything not from loopback. Default `true`. */
  localOnly?: boolean;
  /** One switch per tool group. All `true` by default. */
  tools?: Partial<Record<SwitchableToolGroup, boolean>>;
  logs?: { bufferSize?: number };
  requests?: { bufferSize?: number; idHeader?: string; headers?: RequestHeadersMode };
  /** What the server reports in `initialize`. Default: the app's `package.json`. */
  serverInfo?: { name?: string; version?: string };
}

/** `forFeature` options: like `forRoot`, but `path` is required. */
export type NestMcpFeatureOptions = NestMcpOptions & { path: string };

/**
 * The options that decide the endpoint's route and guards. Nest reads the route before any async
 * factory runs, so in the `*Async` variants these are given statically, next to `useFactory`.
 */
export type NestMcpStaticOptions = Pick<
  NestMcpOptions,
  'enabled' | 'path' | 'guards' | 'localOnly'
>;

/** What an async factory may return: everything but the static options (`enabled` included). */
export type NestMcpFactoryOptions = Omit<NestMcpOptions, 'path' | 'guards' | 'localOnly'>;

export type NestMcpAsyncOptions = ConfigurableModuleAsyncOptions<NestMcpFactoryOptions> &
  NestMcpStaticOptions;

export type NestMcpFeatureAsyncOptions = NestMcpAsyncOptions & { path: string };

export interface ResolvedNestMcpOptions {
  enabled: boolean;
  /** Normalised: no leading or trailing slashes. */
  path: string;
  guards: Type<CanActivate>[];
  localOnly: boolean;
  scope: InstanceScopeKind;
  tools: Record<SwitchableToolGroup, boolean>;
  logs: { bufferSize: number };
  requests: { bufferSize: number; idHeader: string; headers: RequestHeadersMode };
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
 * The endpoint path with no leading or trailing slashes. `forFeature` has no default: the
 * importing module is not known when its decorator argument is evaluated.
 */
export function resolvePath(path: string | undefined, scope: InstanceScopeKind): string {
  if (path === undefined) {
    if (scope === 'module') {
      throw new Error(
        "NestMcpModule.forFeature requires the `path` option, for example `{ path: '_mcp/cats' }`.",
      );
    }
    return DEFAULT_PATH;
  }
  if (typeof path !== 'string') {
    throw new Error('NestMcpModule: the `path` option must be a string.');
  }
  const normalised = trimSlashes(path);
  if (normalised === '') {
    throw new Error("NestMcpModule: the `path` option must not be empty or '/'.");
  }
  return normalised;
}

function positiveInteger(value: number | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`NestMcpModule: \`${option}\` must be a positive integer, got ${value}.`);
  }
  return value;
}

const HEADER_MODES: readonly RequestHeadersMode[] = ['none', 'names', 'full'];

/** Every default applied, `path` normalised and the values checked. */
export function resolveOptions(
  options: NestMcpOptions = {},
  scope: InstanceScopeKind,
): ResolvedNestMcpOptions {
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
    guards: [...(options.guards ?? [])],
    localOnly: options.localOnly ?? true,
    scope,
    tools,
    logs: {
      bufferSize: positiveInteger(
        options.logs?.bufferSize,
        DEFAULT_LOGS_BUFFER_SIZE,
        'logs.bufferSize',
      ),
    },
    requests: {
      bufferSize: positiveInteger(
        options.requests?.bufferSize,
        DEFAULT_REQUESTS_BUFFER_SIZE,
        'requests.bufferSize',
      ),
      idHeader: (options.requests?.idHeader ?? DEFAULT_ID_HEADER).toLowerCase(),
      headers,
    },
    serverInfo: {
      name: options.serverInfo?.name ?? host.name ?? 'nestjs-app',
      version: options.serverInfo?.version ?? host.version ?? '0.0.0',
    },
  };
}
