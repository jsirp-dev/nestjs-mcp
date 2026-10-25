import { defineConfig } from 'tsup';

export default defineConfig({
  // The locals worker is started from its own file, next to the bundle (ADR-0005).
  entry: { index: 'src/index.ts', 'locals-worker': 'src/debug/locals-worker.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  // `__filename` in the sources becomes `fileURLToPath(import.meta.url)` in the ESM build.
  shims: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  external: [/^@nestjs\//, 'reflect-metadata', /^rxjs/, /^@modelcontextprotocol\/sdk/, 'zod'],
});
