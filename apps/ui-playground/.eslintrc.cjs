/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve("@arcaai/config-eslint/library.js")],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
    },
    ignorePatterns: ["**/__tests__/", "vite.config.ts", "vitest.config.ts"],
};
