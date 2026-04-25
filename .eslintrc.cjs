/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: { browser: true, es2022: true, node: true },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', 'vendor', 'public/geo', 'bench/runs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
  },
  overrides: [
    {
      // SPEC Section 8.5 rule 2: Math.random banned in sim/data layers
      files: ['src/sim/**/*.{ts,tsx}', 'src/data/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-globals': [
          'error',
          {
            name: 'Math',
            message: 'Use seedrandom via src/utils/rng.ts. Math.random() forbidden in src/sim/** and src/data/** (SPEC Section 8.5 rule 2).',
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.name='Math'][property.name='random']",
            message: 'Math.random() banned in sim/data layers. Use seedrandom (SPEC Section 8.5).',
          },
        ],
      },
    },
    {
      files: ['scripts/**/*.{ts,tsx}', 'vite.config.ts'],
      env: { node: true },
      rules: { 'no-console': 'off' },
    },
  ],
};
