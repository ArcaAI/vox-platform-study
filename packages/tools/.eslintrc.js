/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: [require.resolve('@arcaai/config-eslint/library.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['dist/**', '**/__tests__/**', 'tests/**', 'scripts/**', 'vitest.config.ts'],
  rules: {
    // Crashes ("Cannot read properties of undefined (reading 'members')") on string
    // enums under eslint 9 + @typescript-eslint 8.57 in eslintrc mode.
    // packages/med-ner carries the same workaround, scoped per-file.
    '@typescript-eslint/no-duplicate-enum-values': 'off',
  },
};
