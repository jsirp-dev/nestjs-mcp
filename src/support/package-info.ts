import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface PackageJson {
  name?: unknown;
  version?: unknown;
}

function readPackageJson(file: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

/** The version of the `@nestjs/core` this package resolves, which is the app's peer. */
export function nestVersion(): string {
  try {
    // `__filename` is native in the CJS build and shimmed by tsup in the ESM build.
    const file = createRequire(__filename).resolve('@nestjs/core/package.json');
    const version = readPackageJson(file)?.version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Name and version of the app, from the `package.json` in the working directory. */
export function hostPackageInfo(): { name?: string; version?: string } {
  const pkg = readPackageJson(join(process.cwd(), 'package.json'));
  return {
    name: typeof pkg?.name === 'string' ? pkg.name : undefined,
    version: typeof pkg?.version === 'string' ? pkg.version : undefined,
  };
}
