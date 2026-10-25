/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  settings: {
    // The package's own name, used by the fixture app, is not an external dependency.
    'import/internal-regex': '^@jsirp/nestjs-mcp$',
  },
  rules: {
    // Nothing outside package.json can be imported; the published code may only use
    // dependencies and peers.
    'import/no-extraneous-dependencies': [
      'error',
      { devDependencies: false, optionalDependencies: false, peerDependencies: true },
    ],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      files: ['test/**/*.ts', '*.config.ts', '*.config.cjs', '.*.cjs'],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          { devDependencies: true, optionalDependencies: false, peerDependencies: true },
        ],
      },
    },
    {
      files: ['*.cjs'],
      env: { node: true },
      parserOptions: { sourceType: 'script' },
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
  ],
};
