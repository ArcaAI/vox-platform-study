// Deprecated app (no development plan) — thin flat shim so the root
// `pnpm lint` pipeline keeps passing after the TASK-418 flat-config
// migration. Ignores replicate the old `.eslintrc.cjs` ignorePatterns plus
// the `--ignore-path .gitignore` entries (node_modules/dist/.turbo come
// from the shared core ignores).
import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['**/__tests__/**', 'vite.config.ts', 'vitest.config.ts', 'e2e/**'],
    },
];
