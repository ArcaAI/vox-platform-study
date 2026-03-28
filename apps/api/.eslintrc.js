/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve('@arcaai/config-eslint/base.js')],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: true,
    },
    ignorePatterns: ['**/__tests__/', 'test/'],
};
