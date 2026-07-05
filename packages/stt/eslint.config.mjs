import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['**/__tests__/**'],
    },
];
