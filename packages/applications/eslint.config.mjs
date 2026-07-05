import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['**/__tests__/**', '**/*.test.ts', 'vitest.config.ts', 'scripts/**'],
    },
];
