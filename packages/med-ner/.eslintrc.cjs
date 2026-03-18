module.exports = {
  root: true,
  extends: [require.resolve('@arcaai/config-eslint/library.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
