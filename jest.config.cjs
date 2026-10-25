/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'cjs', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node10',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          target: 'ES2022',
          strict: true,
          skipLibCheck: true,
          types: ['node', 'jest'],
        },
        // Types are checked by `yarn type-check` (NodeNext); here we only transpile, as CommonJS.
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: {
    // The fixture app consumes the package the way a host does: through its built CJS entry.
    '^@jsirp/nestjs-mcp$': '<rootDir>/dist/index.cjs',
    // NodeNext wants `.js` on relative imports; map them back to the `.ts` sources.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
