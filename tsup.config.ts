import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // `__filename` in the sources becomes `fileURLToPath(import.meta.url)` in the ESM build.
  shims: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  external: [/^@nestjs\//, 'reflect-metadata', /^rxjs/, /^@modelcontextprotocol\/sdk/, 'zod'],
});
