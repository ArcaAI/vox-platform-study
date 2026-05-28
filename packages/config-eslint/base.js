/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [
        'plugin:@typescript-eslint/recommended',
        'plugin:prettier/recommended',
        'prettier',
        'turbo',
    ],
    plugins: ['@typescript-eslint/eslint-plugin', 'arcaai-internal'],
    parser: '@typescript-eslint/parser',
    ignorePatterns: [
        '.*.js',
        '*.setup.js',
        '*.config.js',
        '.turbo/',
        'dist/',
        'coverage/',
        'node_modules/',
    ],
    overrides: [
        {
            // TASK-307 W6.4 (AC-24) — Controllers must route data access
            // through a service or repository. The `arcaai-internal` plugin
            // (packages/config-eslint/eslint-plugin-arcaai-internal/) hosts
            // the custom rule; the escape hatch is `/** @allowedDirectPrisma
            // <reason> */` immediately above the offending line. Allow-list
            // SHOULD be empty after W6 ships — every entry is a deliberate
            // exception that must be reviewed.
            //
            // Scope is intentionally narrow:
            //   <any-prefix>/modules/**/*.controller.ts
            // — the only consumer of `@arcaai/config-eslint` with that
            // path shape is `apps/api` (NestJS module convention).
            //
            // The `files` glob is evaluated against the file path
            // RELATIVE to the directory of the config that contains the
            // override (here: `packages/config-eslint/`). A pattern like
            // `**/apps/api/src/modules/**` would never match because
            // `apps/api/` is not a descendant of `packages/config-eslint/`.
            // Anchoring on the trailing `modules/**/*.controller.ts`
            // segment matches the absolute path correctly via ESLint's
            // path matcher.
            //
            // Service-layer / repository-layer direct-Prisma access
            // remains legitimate and is not restricted.
            files: ['**/modules/**/*.controller.ts'],
            rules: {
                'arcaai-internal/no-controller-direct-prisma': 'error',
            },
        },
        {
            // TASK-311 AC-8 — Services in @arcaai/applications must route
            // data access through a domain-layer repository (UserRepository,
            // PolicyRepository, RbacRoleRepository, RolePolicyRepository,
            // etc.). This is the service-layer analogue of the controller-
            // layer rule above (W6).
            //
            // Implementation note: the W6 plugin's
            // `arcaai-internal/no-controller-direct-prisma` rule is
            // hard-coded to controllers only, and the plugin lives in
            // `packages/eslint-plugin-arcaai-internal/` which is OUTSIDE
            // the modifiable scope for TASK-311 (the plugin is shared
            // infra, owned by W6). TASK-311 therefore implements the
            // service-layer guard via ESLint's built-in
            // `no-restricted-syntax` rule with an AST selector that
            // matches the canonical `<...>.databaseService.client`
            // member-expression chain — exactly the pattern the W6
            // plugin's `isDirectPrismaAccess()` walker detects.
            //
            // Escape hatch: services with a documented exception use the
            // standard ESLint mechanism:
            //
            //     // eslint-disable-next-line no-restricted-syntax
            //     const prisma = this.databaseService.client; // TASK-XXX: <reason>
            //
            // Scope: every `**/services/**/*.service.ts` file inside the
            // packages that extend this config (`packages/applications`
            // via `library.js`, `apps/api` directly). The trailing-segment
            // glob mirrors the controller rule above; ESLint's path
            // matcher resolves it against the file path RELATIVE to the
            // consuming `.eslintrc.js`'s package root (NOT to the
            // config-eslint package), so for `packages/applications` the
            // path it sees is `src/services/rbac/policy/policy.service.ts`.
            // `**/services/**/*.service.ts` matches that correctly.
            //
            // The only `*.service.ts` files in `apps/api` are infra
            // services that don't access Prisma (audited 2026-05-28),
            // so the broad pattern is safe.
            //
            // `excludedFiles` pins:
            //   - Sibling tickets running concurrently with TASK-311
            //     (TASK-308 / TASK-309 / TASK-310 own the extractions
            //     for these other services per the ticket plan §1.4 and
            //     project guard-rails). Each entry MUST be removed when
            //     its owning ticket closes, and the corresponding file
            //     must then be clean.
            //   - `baseServices/**` is permanently allowed: it hosts the
            //     `CoreDatabaseService` / unit-of-work plumbing that
            //     LEGITIMATELY exposes `databaseService.client` to the
            //     repositories.
            files: ['**/services/**/*.service.ts'],
            excludedFiles: [
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
                        // canonical Prisma client access path. The chain
                        // ENDS at `.client`; downstream `.user.findMany(...)`
                        // etc. are wrappers around the same MemberExpression
                        // so we don't need to match them separately.
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
            // reads inside `apps/api/src/modules/**`. All callsites must
            // resolve URLs through the typed `IConfigService.getConfigValue(...)`
            // accessor so env-loading + validation happens once at
            // bootstrap (config.service.ts) instead of per-request. The
            // `arcaai-internal/no-direct-downstream-url-env` rule fires on
            // both dot (`process.env.SMR_URL`) and bracket
            // (`process.env['SMR_URL']`) access for the five known
            // downstream URL keys (SMR_URL, SMR_SERVICE_URL, STT_V2_URL,
            // TTS_URL, NLP_URL). Other env reads (NODE_ENV,
            // npm_package_version, ...) stay legal.
            //
            // Scope mirrors `no-controller-direct-prisma`: `**/modules/**/*.ts`
            // — the only consumer with that path shape is `apps/api`. The
            // config service that ESTABLISHES the env fallback values lives
            // in `packages/applications/src/services/baseServices/_meta/config/`
            // and is correctly excluded by the modules glob.
            files: ['**/modules/**/*.ts'],
            rules: {
                'arcaai-internal/no-direct-downstream-url-env': 'error',
            },
        },
    ],
    rules: {
        // TASK-305 B.5 — Guard the unscoped Prisma client.
        //
        // `getPlatformAdminPrismaClient_Unscoped` bypasses BOTH the tenant-scope
        // and soft-delete `$extends` extensions. It is intended only for:
        //   - DB seed / migration scripts (packages/database/src/prisma/db_main/seed/**)
        //   - one-shot back-fill scripts (packages/database/scripts/**)
        //   - integration / e2e test fixtures (tests/migration/**, tests/helpers/**)
        //   - the platform-admin bypass in CoreDatabaseService.baseClient
        //
        // Anywhere else, prefer `getExtendedPrismaClient()` (or, in NestJS,
        // `coreDatabaseService.client`) so tenant isolation and soft-delete are
        // applied automatically. To use it intentionally inside an allow-listed
        // path, add a line-level `// eslint-disable-next-line no-restricted-imports`
        // comment that names TASK-305 §B.4 and the reason.
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
};