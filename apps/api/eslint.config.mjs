import nestjs from '@arcaai/config-eslint/flat/nestjs.js';

export default [
    ...nestjs,
    {
        ignores: ['**/__tests__/**', 'test/**'],
    },
    {
        // the Playwright e2e specs + shared test helpers under `tests/`
        // (added by the streaming suite) are now IN the lint glob
        // (`{src,tests}` in package.json). Test code legitimately uses `any` for
        // mocks/fixtures and reads test-only env vars that are not part of the
        // build graph, so relax exactly those two rules here. Formatting
        // (prettier) and all correctness rules (unused vars, unsafe types, the
        // arcaai-internal architecture rules) still apply.
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            'turbo/no-undeclared-env-vars': 'off',
        },
    },
];
