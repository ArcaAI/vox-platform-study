/**
 * ESLint 9 FLAT config preset for Next.js apps (TASK-415 Phase 1b).
 *
 * Consumed by future Next.js apps (e.g. `apps/admin-console`) via:
 *
 *     // eslint.config.mjs
 *     import next from '@arcaai/config-eslint/next-flat.js';
 *     export default next;
 *
 * (or `require('@arcaai/config-eslint/next-flat')` from CJS).
 *
 * This file is INDEPENDENT of the legacy eslintrc presets (`base.js`,
 * `next.js`, ...) which existing packages still run with
 * `ESLINT_USE_FLAT_CONFIG=false` on ESLint 8. Do not mix the two.
 *
 * Composition (order matters — later entries win):
 *   1. ignores
 *   2. typescript-eslint v8 recommended (NOT type-checked — keeps lint fast)
 *   3. @next/eslint-plugin-next recommended + core-web-vitals
 *   4. eslint-plugin-react flat recommended (new-JSX-transform aware)
 *   5. eslint-plugin-react-hooks flat recommended
 *   6. house rule conventions carried over from base.js
 *   7. eslint-config-prettier LAST to disable formatting-conflict rules
 */
const nextPlugin = require('@next/eslint-plugin-next');
const prettierConfig = require('eslint-config-prettier');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const tseslint = require('typescript-eslint');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
    {
        name: 'arcaai/ignores',
        ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', '.turbo/**', 'coverage/**'],
    },
    ...tseslint.configs.recommended,
    {
        name: 'arcaai/nextjs',
        plugins: {
            '@next/next': nextPlugin,
        },
        rules: {
            ...nextPlugin.configs.recommended.rules,
            // core-web-vitals upgrades no-html-link-for-pages and
            // no-sync-scripts from warn to error on top of recommended.
            ...nextPlugin.configs['core-web-vitals'].rules,
        },
    },
    {
        // Spread the whole flat config (not just rules) to keep its
        // languageOptions (jsx parser features for plain .jsx files).
        ...reactPlugin.configs.flat.recommended,
        name: 'arcaai/react',
        settings: {
            react: {
                version: 'detect',
            },
        },
        rules: {
            ...reactPlugin.configs.flat.recommended.rules,
            // Next.js uses the automatic JSX runtime — no React import needed.
            'react/react-in-jsx-scope': 'off',
        },
    },
    {
        ...reactHooksPlugin.configs.flat.recommended,
        name: 'arcaai/react-hooks',
    },
    {
        // House conventions carried over from base.js (generic rules only;
        // the arcaai-internal controller/service overrides are NestJS-shaped
        // and do not apply to Next.js apps). `only-warn` is deliberately
        // omitted: it is a packages/* convention, apps fail on errors.
        name: 'arcaai/house-rules',
        rules: {
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            // Honor the leading-underscore convention for intentionally-unused
            // identifiers (mirrors base.js / the TS compiler exemption).
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
            // TASK-305 B.5 — Guard the unscoped Prisma client (same guard as
            // base.js). Server-side Next.js code could import @arcaai/database;
            // the unscoped client bypasses tenant-scope and soft-delete.
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: '@arcaai/database',
                            importNames: ['getPlatformAdminPrismaClient_Unscoped'],
                            message:
                                'TASK-305 §B.4: `getPlatformAdminPrismaClient_Unscoped` bypasses tenant-scope and soft-delete. Use `getExtendedPrismaClient()` (or `CoreDatabaseService.client`) unless this file is on the §B.4 allow-list (seed scripts, migrations, back-fill scripts, test fixtures, CoreDatabaseService).',
                        },
                    ],
                    patterns: [
                        {
                            group: ['**/database/src/client', '**/database/src/client.js', '**/database/src/client.ts'],
                            importNames: ['getPlatformAdminPrismaClient_Unscoped'],
                            message:
                                'TASK-305 §B.4: `getPlatformAdminPrismaClient_Unscoped` bypasses tenant-scope and soft-delete. Use `getExtendedPrismaClient()` unless this file is on the §B.4 allow-list.',
                        },
                    ],
                },
            ],
        },
    },
    // MUST stay last: disables stylistic rules that conflict with Prettier.
    prettierConfig,
];
