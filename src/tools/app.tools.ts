import { VERSION_NEUTRAL, VersioningType, type VersioningOptions } from '@nestjs/common';
import {
  SWITCHABLE_TOOL_GROUPS,
  type RequestHeadersMode,
  type SwitchableToolGroup,
} from '../nest-mcp.options.js';
import { describeScope, type AnswerScope } from '../instance/scope.js';
import { nestVersion } from '../support/package-info.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './tool-context.js';

export type AppInfoVersion = string | 'neutral' | Array<string | 'neutral'>;

export interface AppInfoVersioning {
  type: 'URI' | 'HEADER' | 'MEDIA_TYPE' | 'CUSTOM';
  defaultVersion?: AppInfoVersion;
  /** URI versioning: the segment before the version (`v` unless configured). */
  prefix?: string | false;
  /** Header versioning: the header carrying the version. */
  header?: string;
  /** Media type versioning: the key in the `Accept` header. */
  key?: string;
}

/** What `app_info` answers. */
export interface AppInfo {
  server: { name: string; version: string };
  nest: string;
  node: string;
  uptimeSeconds: number;
  globalPrefix: string;
  versioning: AppInfoVersioning | null;
  mcpPath: string;
  scope: AnswerScope;
  snapshot: boolean;
  /** Which tool groups have tools registered right now. */
  tools: Record<SwitchableToolGroup, boolean>;
  /** The instance's resolved options that decide what it exposes and keeps. */
  options: {
    tools: Record<SwitchableToolGroup, boolean>;
    requests: { headers: RequestHeadersMode };
  };
}

const VERSIONING_TYPES: Record<number, AppInfoVersioning['type']> = {
  [VersioningType.URI]: 'URI',
  [VersioningType.HEADER]: 'HEADER',
  [VersioningType.MEDIA_TYPE]: 'MEDIA_TYPE',
  [VersioningType.CUSTOM]: 'CUSTOM',
};

function describeVersion(version: unknown): AppInfoVersion {
  if (Array.isArray(version)) return version.map((item) => describeVersion(item) as string);
  return version === VERSION_NEUTRAL ? 'neutral' : String(version);
}

function describeVersioning(versioning: VersioningOptions | undefined): AppInfoVersioning | null {
  if (!versioning) return null;
  const described: AppInfoVersioning = { type: VERSIONING_TYPES[versioning.type] ?? 'CUSTOM' };
  if (versioning.defaultVersion !== undefined) {
    described.defaultVersion = describeVersion(versioning.defaultVersion);
  }
  if (versioning.type === VersioningType.URI) described.prefix = versioning.prefix ?? 'v';
  if (versioning.type === VersioningType.HEADER) described.header = versioning.header;
  if (versioning.type === VersioningType.MEDIA_TYPE) described.key = versioning.key;
  return described;
}

export function appInfo(registry: ToolRegistry, context: ToolContext): AppInfo {
  const { options, applicationConfig } = context;
  return {
    server: { ...options.serverInfo },
    nest: nestVersion(),
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    globalPrefix: applicationConfig.getGlobalPrefix(),
    versioning: describeVersioning(applicationConfig.getVersioning()),
    mcpPath: context.mcpPath(),
    scope: describeScope(context.scope()),
    snapshot: context.snapshotEnabled(),
    tools: Object.fromEntries(
      SWITCHABLE_TOOL_GROUPS.map((group) => [group, registry.isLive(group)]),
    ) as Record<SwitchableToolGroup, boolean>,
    options: {
      tools: { ...options.tools },
      requests: { headers: options.requests.headers },
    },
  };
}

export function registerAppTools(registry: ToolRegistry, context: ToolContext): void {
  registry.register('app', {
    name: 'app_info',
    description:
      'What this NestJS app is and how this inspector is mounted: Nest and Node versions, uptime, ' +
      'global prefix, versioning, the endpoint path, the instance scope, whether the app was ' +
      'created with snapshot: true, which tool groups are live, and the tool switches and request ' +
      'header policy this instance was given.',
    handler: () => appInfo(registry, context),
  });
}
