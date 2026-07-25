/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: [require.resolve('@arcaai/config-eslint/library.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: [
    // Emitted by `pnpm db:generate` — not authored here.
    'src/generated/**',
    'dist/**',
    '**/__tests__/**',
    // Excluded from tsconfig.json, so typed linting cannot parse it.
    'src/integration/**',
    'tests/**',
    'scripts/**',
    'vitest.config.ts',
  ],
};
