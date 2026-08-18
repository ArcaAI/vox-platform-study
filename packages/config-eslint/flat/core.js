/**
 * ESLint 9 FLAT foundation shared by every ARCAAI surface preset.
 *
 * 1:1 translation of the legacy eslintrc `base.js` (deleted in the flat-config migration):
 * typescript-eslint recommended + prettier-as-a-rule + turbo + the
 * `arcaai-internal` architecture rules and house conventions.
 *
 * Not a standalone entry point — consumers use a surface preset that spreads
 * this core: `flat/library.js` (packages, only-warn), `flat/nestjs.js`
 * (apps/api, hard errors), `flat/react-library.js`, or `flat/next.js`
 * (self-contained, does NOT spread core — see its header).
 *
 * typescript-eslint v7 → v8 recommended delta (vs the legacy base.js), kept
 * deliberately — see the package README for the parity evidence:
 * - `ban-types` was split into `no-empty-object-type`,
 * `no-unsafe-function-type`, `no-wrapper-object-types` (same coverage).
 * - `no-var-requires` was superseded by `no-require-imports` (superset).
 * - the `no-loss-of-precision` extension rule left the plugin; the base
 * rule is re-enabled below (parity shim).
 * - new in v8 recommended: `no-unused-expressions`,
 * `prefer-namespace-keyword` (zero findings on the current tree).
*/
const arcaaiInternal = require('eslint-plugin-arcaai-internal');
const eslintComments = require('@eslint-community/eslint-plugin-eslint-comments');
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
        // zero new findings (acceptance criterion).
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
        // Every eslint-disable comment must carry a `-- reason`
        // (ESLint's native description syntax) so a suppression is
        // reviewable without re-deriving why it exists. `no-unused-disable`
        // is a free correctness check: a disable that no longer suppresses
        // anything gets flagged instead of rotting in place.
        //
        // Severity is 'warn' repo-wide for now — remediation is clearing the
        // pre-existing backlog of un-justified disables package by package;
        // flipping to 'error' before a package's backlog is clean would
        // just break CI on old debt. `flat/nestjs.js` (apps/api) overrides
        // this to 'error' once its backlog is clear (see that file); the
        // plan is to do the same here once every package is clean.
        name: 'arcaai/eslint-comments',
        plugins: {
            'eslint-comments': eslintComments,
        },
        rules: {
            'eslint-comments/require-description': ['warn', { ignore: [] }],
            'eslint-comments/no-unlimited-disable': 'error',
            'eslint-comments/no-unused-disable': 'warn',
        },
    },
    {
        // Vendored third-party registry components (`shadcn`-style CLI
        // installs under packages/ui) are never hand-edited to add
        // justifications — turn the hygiene rule off there entirely instead
        // of leaving permanent unfixable noise. Other lint rules still run.
        name: 'arcaai/eslint-comments-vendored-override',
        files: ['**/components/registries/**'],
        rules: {
            'eslint-comments/require-description': 'off',
        },
    },
    {
        // Controllers must route data access
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
        // Services in @arcaai/applications must route data
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
        //   - Concurrent extractions still in progress for some services.
        //     Each entry MUST be removed when that extraction closes.
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
        // Forbid direct `process.env.<DOWNSTREAM_URL_KEY>`
        // reads inside `apps/api/src/modules/**`. All callsites must resolve
        // URLs through the typed `IConfigService.getConfigValue(...)`
        // accessor so env-loading + validation happens once at bootstrap.
        // Fires on dot and bracket access for TEXT_URL, TEXT_SERVICE_URL,
        // STT_URL, NLP_URL, GUARDRAIL_URL, HARNESS_URL; other env reads
        // (NODE_ENV, npm_package_version, ...) stay legal.
        name: 'arcaai/modules-no-downstream-url-env',
        files: ['**/modules/**/*.ts'],
        rules: {
            'arcaai-internal/no-direct-downstream-url-env': 'error',
        },
    },
    {
        // TASK-737 §4.4 — every outbound internal service call that sends
        // `X-Service-Token` must also carry a tenant channel. The propagation
        // audit found NINE `apps/api` → `apps/text` call sites that omitted
        // `X-Tenant-Id` entirely, several with a `tenantId` local in scope one
        // line above the HTTP call, and code review caught none of them. This
        // rule is the backstop against the tenth.
        //
        // Scope is every TS source in the gateway and the application-services
        // package — both host peer clients, and the audit found gaps in each.
        // Tests are excluded: a fixture asserting the PRE-fix shape (or a stub
        // client that never reaches a real service) is not a call site.
        name: 'arcaai/internal-calls-require-tenant-header',
        files: ['**/src/**/*.ts'],
        ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts', '**/tests/**'],
        rules: {
            'arcaai-internal/require-internal-tenant-header': 'error',
        },
    },
    {
        // TASK-761 gate G3 (justification half) — a business-plane
        // `@ForbidApiKey()` must record WHY in an `// API-KEY-NOTE`.
        //
        // The presence and the named-exemption halves of G3 are boot audits
        // (`api-key-surface-audit.ts`, `business-plane-apikey-exemptions-audit.ts`)
        // because they are facts about resolved Nest metadata. A REASON is a
        // comment, stripped by `tsc` before metadata exists, so no audit can
        // ever see one — lint is the only mechanism that reads source text.
        //
        // Scope mirrors `no-controller-direct-prisma`: the only package with
        // this path shape is `apps/api`. Tests are excluded — a fixture
        // asserting the pre-fix shape is not a mounted route surface.
        name: 'arcaai/business-plane-apikey-justification',
        files: ['**/modules/**/*.controller.ts'],
        ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
        rules: {
            'arcaai-internal/require-api-key-justification': 'error',
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
            // Guard the unscoped Prisma client.
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
            // that names the allow-list rationale and the reason.
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
