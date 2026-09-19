// Flat config for the load harness.
//
// `pnpm lint` is `turbo run lint`, which runs each WORKSPACE package's own lint
// script — and the repo-root `tests/` tree is not a workspace package, so
// nothing in it is linted by the aggregate. Rather than make `tests/load` a
// workspace member (which would put it in every `turbo` graph), it carries its
// own config and its own `pnpm load:lint`.
//
// Spreads the same `@arcaai/config-eslint/flat/library` preset the packages use,
// so the harness is held to the house rules, then relaxes exactly two for test
// code: `no-explicit-any` (fixtures and captured JSON bodies) and
// `turbo/no-undeclared-env-vars` (LOAD_* knobs are harness-only and must not be
// declared in `turbo.json#globalEnv`, which is for RUNTIME vars).
import library from '@arcaai/config-eslint/flat/library.js';

export default [
  ...library,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { project: null },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
];
