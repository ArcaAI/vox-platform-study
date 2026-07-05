import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: [
            '**/__tests__/**',
            '**/__stories__/**',
            '**/generated/**',
            '**/*.generated.*',
            '**/pierre-dark-theme.js',
            '**/pierre-light-theme.js',
        ],
    },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
];
