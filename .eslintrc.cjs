/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { browser: true, es2022: true, node: true },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', 'vendor', 'public'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    // SPEC Section 2 cấm Math.random ở runtime (deterministic seed required).
    // Bake script runs offline, will need own seedrandom; AST selector keeps
    // Math.sqrt/max/etc. unrestricted.
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[object.name='Math'][property.name='random']",
        message: 'Math.random() banned. Use seedrandom (SPEC Section 2 Cấm dùng).',
      },
    ],
  },
  overrides: [
    {
      files: ['scripts/**/*.{ts,tsx}', 'vite.config.ts'],
      env: { node: true },
      rules: { 'no-console': 'off' },
    },
  ],
};
