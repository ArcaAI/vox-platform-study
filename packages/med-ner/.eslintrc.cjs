module.exports = {
  root: true,
  extends: [require.resolve('@arcaai/config-eslint/library.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['**/__tests__/'],
  overrides: [
    {
      files: ['src/types/index.ts'],
      rules: {
        '@typescript-eslint/no-duplicate-enum-values': 'off',
      },
    },
  ],
};
