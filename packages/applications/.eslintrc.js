/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve("@arcaai/config-eslint/library.js")],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
    },
    ignorePatterns: ["dist/", ".turbo/", "node_modules/", "**/__tests__/", "**/*.test.ts"],
};
