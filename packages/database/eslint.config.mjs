import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: [
            // Emitted by `pnpm db:generate` — not authored here.
            'src/generated/**',
            'dist/**',
            '**/__tests__/**',
            'tests/**',
            'scripts/**',
            'vitest.config.ts',
        ],
    },
];
