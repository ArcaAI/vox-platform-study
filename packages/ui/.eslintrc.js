/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve("@arcaai/config-eslint/library.js")],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
    },
    ignorePatterns: [
        "**/__tests__/",
        "**/__stories__/",
        "**/generated/**",
        "**/*.generated.*",
        "**/pierre-dark-theme.js",
        "**/pierre-light-theme.js",
    ],
    rules: {
        "@typescript-eslint/no-explicit-any": "off",
    },
};
