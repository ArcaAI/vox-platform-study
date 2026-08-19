/**
 * ESLint 9 FLAT config preset for Next.js apps (moved
 * into the flat preset family as `flat/next.js` by — content
 * unchanged from the former `next-flat.js`).
 *
 * Consumed by Next.js apps (e.g. `apps/admin-console`) via:
 *
 * // eslint.config.mjs
 * import next from '@arcaai/config-eslint/flat/next.js';
 * export default next;
 *
 * (or `require('@arcaai/config-eslint/flat/next')` from CJS).
 *
 * Deliberately self-contained (does NOT spread `flat/core.js`): the
 * arcaai-internal controller/service overrides are NestJS-shaped, prettier
 * runs as a formatter (not a lint rule) in Next.js apps, and `only-warn` is
 * a packages/* convention — apps fail on errors.
 *
 * Composition (order matters — later entries win):
 * 1. ignores
 * 2. typescript-eslint v8 recommended (NOT type-checked — keeps lint fast)
 * 3. @next/eslint-plugin-next recommended + core-web-vitals
 * 4. eslint-plugin-react flat recommended (new-JSX-transform aware)
 * 5. eslint-plugin-react-hooks flat recommended
 * 6. house rule conventions carried over from the shared core
 * 7. eslint-config-prettier LAST to disable formatting-conflict rules
 */
const { fixupPluginRules } = require('@eslint/compat');
const eslintComments = require('@eslint-community/eslint-plugin-eslint-comments');
const nextPlugin = require('@next/eslint-plugin-next');
const prettierConfig = require('eslint-config-prettier');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const tseslint = require('typescript-eslint');

/**
 * Guard the unscoped Prisma client (same guard as the shared core).
 * Server-side Next.js code could import @arcaai/database; the unscoped client
 * bypasses tenant-scope and soft-delete. Hoisted so the feature-scoped
 * override below can re-declare it — `no-restricted-imports` REPLACES its
 * config per file group, it does not merge.
 */
const UNSCOPED_PRISMA_PATH = {
  name: '@arcaai/database',
  importNames: ['getPlatformAdminPrismaClient_Unscoped'],
  message:
    'TASK-305 §B.4: `getPlatformAdminPrismaClient_Unscoped` bypasses tenant-scope and soft-delete. Use `getExtendedPrismaClient()` (or `CoreDatabaseService.client`) unless this file is on the §B.4 allow-list (seed scripts, migrations, back-fill scripts, test fixtures, CoreDatabaseService).',
};

const UNSCOPED_PRISMA_PATTERN = {
  group: ['**/database/src/client', '**/database/src/client.js', '**/database/src/client.ts'],
  importNames: ['getPlatformAdminPrismaClient_Unscoped'],
  message:
    'TASK-305 §B.4: `getPlatformAdminPrismaClient_Unscoped` bypasses tenant-scope and soft-delete. Use `getExtendedPrismaClient()` unless this file is on the §B.4 allow-list.',
};

/**
 * TASK-769: record detail/edit lives in ONE console-wide surface
 * (`src/shared/detail/detail-drawer.tsx`), per `11-ux-ui-principles.md`
 * §1 Detail Surface. A feature module that reaches for `SheetContent` is
 * hand-rolling a second detail surface, which is exactly what that rule
 * retires. `Sheet` itself is useless without `SheetContent`, so banning the
 * one import closes the hole. The drawer itself lives OUTSIDE `src/features/**`
 * (see `ignores` below), so it keeps its own import.
 */
const HANDROLLED_SHEET_PATH = {
  name: '@arcaai/ui/components/shadcn/sheet',
  importNames: ['SheetContent'],
  message:
    'Record detail/edit belongs in the console-wide `DetailDrawer` (@/shared/detail/detail-drawer), not a feature-local Sheet — see .claude/rules/11-ux-ui-principles.md §1 Detail Surface. Short confirmations stay Dialogs.',
};

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
    // eslint-plugin-react 7.37.x still calls context.getFilename(),
    // removed in ESLint 10 — fixupPluginRules restores the legacy
    // context methods (harmless on ESLint 9). Drop once the plugin
    // declares ESLint 10 support.
    plugins: {
      react: fixupPluginRules(reactPlugin),
    },
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
    // House conventions carried over from the shared core (generic rules
    // only; the arcaai-internal controller/service overrides are
    // NestJS-shaped and do not apply to Next.js apps). `only-warn` is
    // deliberately omitted: it is a packages/* convention, apps fail on
    // errors.
    name: 'arcaai/house-rules',
    plugins: {
      'eslint-comments': eslintComments,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Honor the leading-underscore convention for intentionally-unused
      // identifiers (mirrors the shared core / the TS compiler exemption).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Same hygiene rule as the shared core: every
      // eslint-disable comment must carry a `-- reason`. 'warn' until
      // this app's backlog is clean (see flat/core.js for the full
      // rationale).
      'eslint-comments/require-description': ['warn', { ignore: [] }],
      'eslint-comments/no-unlimited-disable': 'error',
      'eslint-comments/no-unused-disable': 'warn',
      // Guard the unscoped Prisma client (same guard as
      // the shared core). Server-side Next.js code could import
      // @arcaai/database; the unscoped client bypasses tenant-scope and
      // soft-delete.
      'no-restricted-imports': ['error', { paths: [UNSCOPED_PRISMA_PATH], patterns: [UNSCOPED_PRISMA_PATTERN] }],
    },
  },
  {
    // Feature modules may not hand-roll a record-detail Sheet. Scoped to
    // `src/features/**` so the shared drawer (`src/shared/detail/**`) and
    // the UI package keep their own `SheetContent` import.
    name: 'arcaai/no-handrolled-detail-sheet',
    files: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    ignores: ['src/shared/detail/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [UNSCOPED_PRISMA_PATH, HANDROLLED_SHEET_PATH], patterns: [UNSCOPED_PRISMA_PATTERN] }],
    },
  },
  // MUST stay last: disables stylistic rules that conflict with Prettier.
  prettierConfig,
];
