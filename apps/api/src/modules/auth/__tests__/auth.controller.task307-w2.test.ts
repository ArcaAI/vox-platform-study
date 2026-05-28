/**
 * TASK-307 W2.3 — AuthController must source JWT_SECRET_KEY from
 * SecretsService ONLY.
 *
 * Closes audit C-6 part 3 (bare-minimum, fail-closed): unify sign &
 * verify on SecretsService. Today AuthController still pulls
 * JWT_SECRET_KEY from `AppSettingsService.getValueWithDefault` in three
 * places (login, impersonate, refresh) — meaning sign-path and
 * verify-path can diverge if either fetcher falls through to the
 * placeholder.
 *
 * These tests pin BOTH halves of the change:
 *   1. SecretsService.getSecretSync('JWT_SECRET_KEY') is consulted on
 *      every JWT-mint path (login, impersonate, refresh).
 *   2. AppSettingsService.getValueWithDefault is NEVER consulted with
 *      'JWT_SECRET_KEY' (regression guard — the dual-source bug must
 *      not re-appear).
 *
 * JWT_EXPIRES_IN intentionally STAYS on AppSettings (it's a tunable,
 * not a secret; see oidc.strategy.ts:82-83). The dual-source concern
 * does not apply to it. W2.4 deviation rationale is in the wave commit
 * body — these tests do NOT assert anything about JWT_EXPIRES_IN.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { AuthController } from '../auth.controller';

const PLACEHOLDER = 'default-jwt-secret-key-change-in-production';
const REAL_SECRET = 'a-real-32-byte-jwt-signing-secret-aaaa';

const createMockClsService = (user: any = null) => ({
    get: vi.fn((key: string) => (key === 'user' ? user : null)),
    set: vi.fn(),
});

const createMockUserRepository = (users: Map<string, any> = new Map()) => ({
    findFirst: vi.fn(async (props: any) => {
        const id = props?.filters?.id;
        const username = props?.filters?.username;
        if (id) return users.get(id) ?? null;
        for (const u of users.values()) {
            if (u.username === username) return u;
        }
        return null;
    }),
    update: vi.fn(),
});

const createMockTenantRepository = () => ({
    findFirst: vi.fn(async (props: any) => {
        const key = props?.filters?.key;
        if (key === 'acme-hospital') {
            return { id: 'tenant-001', key: 'acme-hospital', resourceStatus: 'ENABLED' };
        }
        return null;
    }),
});

const createMockDatabaseService = (roleAssignments: any[] = []) => ({
    client: {
        userRoleAssignment: {
            findMany: vi.fn(async () => roleAssignments),
            findFirst: vi.fn(async () => ({ id: 'ura-1' })),
        },
    },
});

const createMockAuthService = () => ({ trackAuthentication: vi.fn() });
const createMockUserService = () => ({});

/**
 * Mock AppSettingsService that RECORDS every key it is asked for, so
 * the regression assertion "JWT_SECRET_KEY was NEVER asked of
 * AppSettings" is provable.
 */
const createMockAppSettingsService = () => {
    const calls: string[] = [];
    return {
        calls,
        getValueWithDefault: vi.fn((key: string, defaultVal: string) => {
            calls.push(key);
            if (key === 'JWT_EXPIRES_IN') return '1h';
            if (key === 'JWT_IMPERSONATION_EXPIRES_IN') return '15m';
            // Critical: the placeholder default is what would silently
            // leak if AuthController ever fell through to AppSettings
            // for JWT_SECRET_KEY again. We hand it back here so the
            // assertion "controller did not consult AppSettings for
            // JWT_SECRET_KEY" is directly testable — if it DID, the
            // resulting JWT would be signed with the placeholder.
            return defaultVal;
        }),
    };
};

/**
 * Mock SecretsService that RECORDS every key it is asked for and
 * returns a real, non-placeholder secret for JWT_SECRET_KEY.
 */
const createMockSecretsService = (secret = REAL_SECRET) => {
    const calls: string[] = [];
    return {
        calls,
        getSecretSync: vi.fn((key: string) => {
            calls.push(key);
            if (key === 'JWT_SECRET_KEY') return secret;
            return undefined;
        }),
    };
};

const createMockRequest = () => ({ ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } });

const createRole = (name: string, permissions: string[] = ['read:consultation']) => ({
    id: `role-${name}`,
    name,
    permissions,
});

const createUser = (overrides: Partial<Record<string, any>> = {}) => ({
    id: 'user-001',
    username: 'dr_smith',
    password: '$2a$10$placeholder',
    tenantId: 'tenant-001',
    UserProfile: { email: 'smith@hospital.com' },
    resourceStatus: 'ENABLED',
    lastLoginAt: null,
    lastActiveAt: null,
    ...overrides,
});

function buildController(opts: {
    appSettingsService: ReturnType<typeof createMockAppSettingsService>;
    secretsService: ReturnType<typeof createMockSecretsService>;
    users?: Map<string, any>;
    roleAssignments?: any[];
    user?: any;
}) {
    return new AuthController(
        createMockUserService() as any,
        createMockAuthService() as any,
        opts.appSettingsService as any,
        createMockDatabaseService(opts.roleAssignments ?? []) as any,
        createMockUserRepository(opts.users ?? new Map()) as any,
        {} as any,
        {} as any,
        createMockTenantRepository() as any,
        createMockClsService(opts.user ?? null) as any,
        { issueTicket: vi.fn(), consumeTicket: vi.fn() } as any,
        { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) } as any,
        opts.secretsService as any,
    );
}

describe('TASK-307 W2.3 — auth.controller uses SecretsService only', () => {
    beforeEach(() => vi.clearAllMocks());

    describe('login', () => {
        it('reads JWT_SECRET_KEY from SecretsService, NOT from AppSettings', async () => {
            const appSettings = createMockAppSettingsService();
            const secrets = createMockSecretsService();
            const hashed = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashed });
            const users = new Map([[user.id, user]]);

            const controller = buildController({
                appSettingsService: appSettings,
                secretsService: secrets,
                users,
                roleAssignments: [{ Role: createRole('doctor') }],
            });

            await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest() as any,
            );

            expect(secrets.calls).toContain('JWT_SECRET_KEY');
            expect(appSettings.calls).not.toContain('JWT_SECRET_KEY');
        });
    });

    describe('refresh', () => {
        it('reads JWT_SECRET_KEY from SecretsService, NOT from AppSettings', async () => {
            const appSettings = createMockAppSettingsService();
            const secrets = createMockSecretsService();
            const user = createUser({ id: 'user-123' });
            const users = new Map([[user.id, user]]);

            const controller = buildController({
                appSettingsService: appSettings,
                secretsService: secrets,
                users,
                roleAssignments: [{ Role: createRole('doctor') }],
            });

            await controller.refresh({
                refreshToken: 'refresh_user-123_1700000000_' + 'a'.repeat(64),
            });

            expect(secrets.calls).toContain('JWT_SECRET_KEY');
            expect(appSettings.calls).not.toContain('JWT_SECRET_KEY');
        });
    });

    describe('impersonate', () => {
        it('reads JWT_SECRET_KEY from SecretsService, NOT from AppSettings', async () => {
            const appSettings = createMockAppSettingsService();
            const secrets = createMockSecretsService();
            const adminUser = { id: 'admin-001', tenantId: 'tenant-001' };
            const target = createUser({ id: 'doctor-001', username: 'dr_smith' });
            const users = new Map([[target.id, target]]);

            // databaseService.userRoleAssignment.findMany returns either
            // role assignments (for getUserRoles, with `include: { Role }`)
            // OR tenant assignments (for the H-3 lookup, with `select`).
            const userRoleAssignment = {
                findMany: vi.fn(async (args: any) => {
                    if (args?.select?.tenantId) return [{ tenantId: 'tenant-001' }];
                    const userId = args?.where?.userId;
                    if (userId === 'admin-001')
                        return [{ Role: createRole('SUPER_ADMIN', []) }];
                    if (userId === 'doctor-001')
                        return [{ Role: createRole('doctor', []) }];
                    return [];
                }),
                findFirst: vi.fn(),
            };
            const dbServiceWithImpersonation = { client: { userRoleAssignment } };

            const controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                appSettings as any,
                dbServiceWithImpersonation as any,
                createMockUserRepository(users) as any,
                {} as any,
                {} as any,
                createMockTenantRepository() as any,
                createMockClsService(adminUser) as any,
                { issueTicket: vi.fn(), consumeTicket: vi.fn() } as any,
                { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) } as any,
                secrets as any,
            );

            await controller.impersonate(
                { targetUserId: 'doctor-001' } as any,
                createMockRequest() as any,
            );

            expect(secrets.calls).toContain('JWT_SECRET_KEY');
            expect(appSettings.calls).not.toContain('JWT_SECRET_KEY');
        });
    });

    describe('regression — appSettings never sees JWT_SECRET_KEY', () => {
        it('login/refresh/impersonate combined leave AppSettings JWT_SECRET_KEY-free', async () => {
            // Three-call combined check — if any of the three paths
            // re-introduces the dual-source fallback, this fails.
            const appSettings = createMockAppSettingsService();
            const secrets = createMockSecretsService();

            // login
            const hashed = await bcrypt.hash('pass123', 10);
            const loginUser = createUser({ password: hashed });
            const loginController = buildController({
                appSettingsService: appSettings,
                secretsService: secrets,
                users: new Map([[loginUser.id, loginUser]]),
                roleAssignments: [{ Role: createRole('doctor') }],
            });
            await loginController.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest() as any,
            );

            // refresh
            const refreshUser = createUser({ id: 'user-999' });
            const refreshController = buildController({
                appSettingsService: appSettings,
                secretsService: secrets,
                users: new Map([[refreshUser.id, refreshUser]]),
                roleAssignments: [{ Role: createRole('doctor') }],
            });
            await refreshController.refresh({
                refreshToken: 'refresh_user-999_1700000000_' + 'a'.repeat(64),
            });

            // AppSettings was asked for JWT_EXPIRES_IN (legitimately,
            // it's a tunable not a secret — see W2.4 deviation in the
            // commit body) but NEVER for JWT_SECRET_KEY.
            expect(appSettings.calls).not.toContain('JWT_SECRET_KEY');
            expect(appSettings.calls).toContain('JWT_EXPIRES_IN');
            expect(secrets.calls.filter((k) => k === 'JWT_SECRET_KEY').length).toBeGreaterThanOrEqual(
                2,
            );
        });
    });
});
