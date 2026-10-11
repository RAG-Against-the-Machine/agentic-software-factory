import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // .hermes-run/ is gitignored local scratch (e2e harnesses), never shipped.
  { ignores: ['**/dist/**', '**/node_modules/**', '.hermes-run/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `_`-prefixed names are deliberately unused (loop counters, destructured-away fields).
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  {
    // Plain-JS Node entry points: dev/e2e scripts and the worker's Claude Code hooks.
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
