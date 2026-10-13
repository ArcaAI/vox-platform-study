import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        // Generated Prisma client, migration SQL tooling output, build output, and the test trees
        // (mirrors packages/domains, which also lints production code only).
        ignores: ['**/generated/**', 'dist/**', '**/__tests__/**', 'src/integration/**', 'vitest.config.ts', 'vitest.*.config.ts'],
    },
];
