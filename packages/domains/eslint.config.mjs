import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['src/__tests__/**', 'src/integration/**', '**/generated/**', '**/__tests__/**', 'vitest.config.ts'],
    },
    {
        files: ['src/common/repository.ts', 'src/common/databaseServices/**/*.ts', 'src/common/autoMappers/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
];
