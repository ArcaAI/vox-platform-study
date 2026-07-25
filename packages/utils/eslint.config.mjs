import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['dist/**', '**/__tests__/**', 'tests/**', 'scripts/**', 'vitest.config.ts'],
    },
];
