/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve("@arcaai/config-eslint/library.js")],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
    },
    ignorePatterns: [
        "dist/",
        ".turbo/",
        "node_modules/",
        "src/__tests__/",
        "src/integration/",
        "**/generated/**",
        "**/__tests__/",
        "vitest.config.ts",
    ],
    overrides: [
        {
            files: [
                "src/common/repository.ts",
                "src/common/databaseServices/**/*.ts",
                "src/common/autoMappers/**/*.ts",
            ],
            rules: {
                "@typescript-eslint/no-explicit-any": "off",
            },
        },
    ],
};