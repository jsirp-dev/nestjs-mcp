import {
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
  type VersioningOptions,
} from '@nestjs/common';

/** The version metadata Nest records on a route: a string, `VERSION_NEUTRAL`, or a list of both. */
export type VersionValue = string | symbol | Array<string | symbol>;

/** What the inspector reads from `getGlobalPrefixOptions().exclude`. */
export interface ExcludedRoute {
  requestMethod: number;
  pathRegex?: { test(path: string): boolean };
}

export interface PathSettings {
  globalPrefix: string;
  versioning: VersioningOptions | undefined;
  exclude: readonly ExcludedRoute[];
}

function versionText(version: string | symbol): string {
  return version === VERSION_NEUTRAL ? 'neutral' : String(version);
}

function uriVersionPrefix(versioning: VersioningOptions | undefined): string {
  if (versioning?.type !== VersioningType.URI) return '';
  return versioning.prefix === false ? '' : (versioning.prefix ?? 'v');
}

/** Whether `path` starts with the segment `segment` (`/api` in `/api/cats`, not in `/apis`). */
function startsWithSegment(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`);
}

function excluded(exclude: readonly ExcludedRoute[], path: string, method: string): boolean {
  const wanted = RequestMethod[method as keyof typeof RequestMethod];
  return exclude.some(
    (route) =>
      (route.requestMethod === RequestMethod.ALL ||
        route.requestMethod === -1 ||
        route.requestMethod === wanted) &&
      route.pathRegex?.test(path) === true,
  );
}

/**
 * The version a route answers on. URI versioning registers one path per version, so a list
 * resolves to the version in that path; other kinds keep the list.
 */
export function routeVersion(
  value: VersionValue | undefined,
  path: string,
  settings: PathSettings,
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return versionText(value);
  if (settings.versioning?.type !== VersioningType.URI) return value.map(versionText);
  const prefix = uriVersionPrefix(settings.versioning);
  const segments = path.split('/');
  const found = value.find(
    (version) => typeof version === 'string' && segments.includes(`${prefix}${version}`),
  );
  return versionText(found ?? VERSION_NEUTRAL);
}

/**
 * Undoes what Nest added to a route's path: the global prefix (unless the route is excluded
 * from it) and the URI version segment. Nest itself computes the full path; the raw one is what
 * the controller and method declare, and what middlewares and header-versioned apps see.
 */
export function rawPath(
  fullPath: string,
  method: string,
  version: string | string[] | undefined,
  settings: PathSettings,
): string {
  let path = fullPath;
  const prefix = settings.globalPrefix.replace(/^\/+|\/+$/g, '');
  const versionSegment =
    settings.versioning?.type === VersioningType.URI && typeof version === 'string'
      ? version === 'neutral'
        ? undefined
        : `/${uriVersionPrefix(settings.versioning)}${version}`
      : undefined;
  const unversioned = (candidate: string) =>
    versionSegment !== undefined && startsWithSegment(candidate, versionSegment)
      ? candidate.slice(versionSegment.length) || '/'
      : candidate;

  // An excluded route whose own path starts with the prefix keeps it.
  if (
    prefix &&
    startsWithSegment(path, `/${prefix}`) &&
    !excluded(settings.exclude, unversioned(path), method)
  ) {
    path = path.slice(prefix.length + 1) || '/';
  }
  return unversioned(path);
}
