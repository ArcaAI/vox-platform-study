import nestjs from '@arcaai/config-eslint/flat/nestjs.js';

export default [
    ...nestjs,
    {
        ignores: ['**/__tests__/**', 'test/**'],
    },
];
