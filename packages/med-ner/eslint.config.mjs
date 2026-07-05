import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['**/__tests__/**'],
    },
    {
        files: ['src/types/index.ts'],
        rules: {
            '@typescript-eslint/no-duplicate-enum-values': 'off',
        },
    },
];
