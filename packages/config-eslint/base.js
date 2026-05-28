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
            //   apps/api/src/modules/**/*.controller.ts  — the offender surface
            // Service-layer / repository-layer direct-Prisma access remains
            // legitimate and is not restricted.
            files: ['**/apps/api/src/modules/**/*.controller.ts'],
            rules: {
                'arcaai-internal/no-controller-direct-prisma': 'error',
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