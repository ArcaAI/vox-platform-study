/**
 * ESLint 9 FLAT foundation shared by every ARCAAI surface preset (TASK-418).
 *
 * 1:1 translation of the legacy eslintrc `base.js` (deleted in TASK-418):
 * typescript-eslint recommended + prettier-as-a-rule + turbo + the
 * `arcaai-internal` architecture rules and house conventions.
 *
 * Not a standalone entry point — consumers use a surface preset that spreads
 * this core: `flat/library.js` (packages, only-warn), `flat/nestjs.js`
 * (apps/api, hard errors), `flat/react-library.js`, or `flat/next.js`
 * (self-contained, does NOT spread core — see its header).
 *
 * typescript-eslint v7 → v8 recommended delta (vs the legacy base.js), kept
 * deliberately — see TASK-418 README for the parity evidence:
 *   - `ban-types` was split into `no-empty-object-type`,
 *     `no-unsafe-function-type`, `no-wrapper-object-types` (same coverage).
 *   - `no-var-requires` was superseded by `no-require-imports` (superset).
 *   - the `no-loss-of-precision` extension rule left the plugin; the base
 *     rule is re-enabled below (parity shim).
 *   - new in v8 recommended: `no-unused-expressions`,
 *     `prefer-namespace-keyword` (zero findings on the current tree).
 */
const arcaaiInternal = require('eslint-plugin-arcaai-internal');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const tseslint = require('typescript-eslint');

// eslint-config-turbo ships ESM-shaped CJS; unwrap the default export.
const turboFlatModule = require('eslint-config-turbo/flat');
const turboFlat = turboFlatModule.default ?? turboFlatModule;

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
    {
        // Translation of the legacy base.js/library.js ignorePatterns.
        // `**/eslint.config.mjs` is the flat analogue of `.*.js` covering the
        // old `.eslintrc.js`: the lint config itself is not linted.
        name: 'arcaai/ignores',
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.turbo/**',
            '**/coverage/**',
            '**/.*.js',
            '**/*.setup.js',
            '**/*.config.js',
            '**/eslint.config.mjs',
        ],
    },
    {
        // Parity shim: flat config defaults `reportUnusedDisableDirectives`
        // to "warn"; the legacy eslintrc runs never reported unused disable
        // directives. Keep the legacy behavior so the migration introduces
        // zero new findings (TASK-418 acceptance criterion).
        name: 'arcaai/linter-options',
        linterOptions: {
            reportUnusedDisableDirectives: 'off',
        },
    },
    ...tseslint.configs.recommended,
    // Registers the prettier plugin, sets `prettier/prettier: error`, and
    // includes eslint-config-prettier (disables formatting-conflict rules) —
    // the flat equivalent of the legacy `plugin:prettier/recommended` +
    // `prettier` pair.
    prettierRecommended,
    ...turboFlat,
    {
        name: 'arcaai/arcaai-internal-plugin',
        plugins: {
            'arcaai-internal': arcaaiInternal,
        },
    },
    {
        // TASK-307 W6.4 (AC-24) — Controllers must route data access
        // through a service or repository. The escape hatch is
        // `/** @allowedDirectPrisma <reason> */` immediately above the
        // offending line. Allow-list SHOULD be empty — every entry is a
        // deliberate exception that must be reviewed.
        //
        // Scope is intentionally narrow: `**/modules/**/*.controller.ts` —
        // the only consumer with that path shape is `apps/api` (NestJS
        // module convention). Flat `files` globs resolve against the
        // directory of the consumer's `eslint.config.mjs` (the package
        // root), so the trailing-segment anchor matches exactly like the
        // legacy override did.
        //
        // Service-layer / repository-layer direct-Prisma access remains
        // legitimate and is not restricted.
        name: 'arcaai/controller-no-direct-prisma',
        files: ['**/modules/**/*.controller.ts'],
        rules: {
            'arcaai-internal/no-controller-direct-prisma': 'error',
        },
    },
    {
        // TASK-311 AC-8 — Services in @arcaai/applications must route data
        // access through a domain-layer repository (UserRepository,
        // PolicyRepository, RbacRoleRepository, RolePolicyRepository, ...).
        // Service-layer analogue of the controller rule above, implemented
        // via ESLint's built-in `no-restricted-syntax` with an AST selector
        // matching the canonical `<...>.databaseService.client` chain.
        //
        // Escape hatch (standard ESLint mechanism):
        //
        //     // eslint-disable-next-line no-restricted-syntax
        //     const prisma = this.databaseService.client; // TASK-XXX: <reason>
        //
        // The `ignores` list is the flat equivalent of the legacy
        // `excludedFiles` pins:
        //   - Sibling tickets running concurrently with TASK-311 (TASK-308 /
        //     TASK-309 / TASK-310 own the extractions for these services).
        //     Each entry MUST be removed when its owning ticket closes.
        //   - `baseServices/**` is permanently allowed: it hosts the
        //     `CoreDatabaseService` / unit-of-work plumbing that LEGITIMATELY
        //     exposes `databaseService.client` to the repositories.
        name: 'arcaai/service-repository-boundary',
        files: ['**/services/**/*.service.ts'],
        ignores: [
            '**/services/audit/**',
            '**/services/tenant/**',
            '**/services/user/userRoleAssignment/**',
            '**/services/baseServices/**',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    // Matches `<receiver>.databaseService.client` — the
                    // canonical Prisma client access path. The chain ENDS at
                    // `.client`; downstream `.user.findMany(...)` etc. are
                    // wrappers around the same MemberExpression so we don't
                    // need to match them separately.
                    selector:
                        "MemberExpression[computed=false][property.name='client'][object.type='MemberExpression'][object.computed=false][object.property.name='databaseService']",
                    message:
                        'TASK-311 AC-8: services in @arcaai/applications must not access `this.databaseService.client` directly. Route through a domain-layer repository (UserRepository, PolicyRepository, RbacRoleRepository, RolePolicyRepository, ...). If this access is genuinely unavoidable, silence with `// eslint-disable-next-line no-restricted-syntax` and document the reason on the same block.',
                },
            ],
        },
    },
    {
        // TASK-310 E-5 (AC-5) — Forbid direct `process.env.<DOWNSTREAM_URL_KEY>`
        // reads inside `apps/api/src/modules/**`. All callsites must resolve
        // URLs through the typed `IConfigService.getConfigValue(...)`
        // accessor so env-loading + validation happens once at bootstrap.
        // Fires on dot and bracket access for SMR_URL, SMR_SERVICE_URL,
        // STT_V2_URL, NLP_URL, GUARDRAIL_URL, HARNESS_URL; other env reads
        // (NODE_ENV, npm_package_version, ...) stay legal.
        name: 'arcaai/modules-no-downstream-url-env',
        files: ['**/modules/**/*.ts'],
        rules: {
            'arcaai-internal/no-direct-downstream-url-env': 'error',
        },
    },
    {
        name: 'arcaai/house-rules',
        rules: {
            // Parity shim for the typescript-eslint v7 → v8 move: v7
            // recommended enabled the (now removed) extension rule
            // `@typescript-eslint/no-loss-of-precision`; the base rule is
            // its direct successor.
            'no-loss-of-precision': 'error',
            // Honor the leading-underscore convention for intentionally-unused
            // identifiers (e.g. interface-required parameters such as
            // `rotateSecret(_key)` that a given provider does not use). Mirrors
            // the TS compiler's `noUnusedParameters` exemption for `_`-prefixed
            // names.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
            // TASK-305 B.5 — Guard the unscoped Prisma client.
            //
            // `getPlatformAdminPrismaClient_Unscoped` bypasses BOTH the
            // tenant-scope and soft-delete `$extends` extensions. It is
            // intended only for:
            //   - DB seed / migration scripts (packages/database/src/prisma/db_main/seed/**)
            //   - one-shot back-fill scripts (packages/database/scripts/**)
            //   - integration / e2e test fixtures (tests/migration/**, tests/helpers/**)
            //   - the platform-admin bypass in CoreDatabaseService.baseClient
            //
            // Anywhere else, prefer `getExtendedPrismaClient()` (or, in
            // NestJS, `coreDatabaseService.client`) so tenant isolation and
            // soft-delete are applied automatically. To use it intentionally
            // inside an allow-listed path, add a line-level
            // `// eslint-disable-next-line no-restricted-imports` comment
            // that names TASK-305 §B.4 and the reason.
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
];
