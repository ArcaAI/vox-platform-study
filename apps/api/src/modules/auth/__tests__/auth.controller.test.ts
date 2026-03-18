/**
 * AuthController — Comprehensive Unit Tests
 *
 * Covers login, me, logout endpoints + private helper methods (getUserRoles, getUserPermissions)
 * tested indirectly through public endpoint behavior.
 *
 * Security-specific tests live in auth.controller.task224.test.ts — this file covers
 * everything else: happy paths, edge cases, error handling, and catch-block resilience.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthController } from '../auth.controller';

// ---------------------------------------------------------------------------
// Factories (consistent with task224 patterns)
// ---------------------------------------------------------------------------

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

const createMockDatabaseService = (roleAssignments: any[] = [], tenantAssignment: any = { id: 'ura-1' }) => ({
    client: {
        userRoleAssignment: {
            findMany: vi.fn(async () => roleAssignments),
            findFirst: vi.fn(async () => tenantAssignment),
        },
    },
});

const createMockAuthService = () => ({
    trackAuthentication: vi.fn(),
    revokeToken: vi.fn(),
});

const createMockAppSettingsService = () => ({
    getValueWithDefault: vi.fn((key: string, defaultVal: string) => {
        if (key === 'JWT_SECRET_KEY') return 'test-secret-key-for-unit-tests';
        if (key === 'JWT_EXPIRES_IN') return '1h';
        if (key === 'JWT_IMPERSONATION_EXPIRES_IN') return '15m';
        return defaultVal;
    }),
});

const createMockUserService = () => ({});

const createMockRequest = (ip = '127.0.0.1') => ({
    ip,
    headers: { 'user-agent': 'test-agent' },
});

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

const createMockTenantRepository = (tenants: Map<string, any> = new Map()) => ({
    findFirst: vi.fn(async (props: any) => {
        const key = props?.filters?.key;
        if (key) {
            for (const t of tenants.values()) {
                if (t.key === key) return t;
            }
        }
        return null;
    }),
});

const createTenant = (overrides: Partial<Record<string, any>> = {}) => ({
    id: 'tenant-001',
    key: 'acme-hospital',
    name: 'Acme Hospital',
    resourceStatus: 'ENABLED',
    ...overrides,
});

function buildController(overrides: {
    userService?: any;
    authService?: any;
    appSettingsService?: any;
    databaseService?: any;
    userRepository?: any;
    userRoleAssignmentRepository?: any;
    roleRepository?: any;
    tenantRepository?: any;
    clsService?: any;
} = {}) {
    return new AuthController(
        (overrides.userService ?? createMockUserService()) as any,
        (overrides.authService ?? createMockAuthService()) as any,
        (overrides.appSettingsService ?? createMockAppSettingsService()) as any,
        (overrides.databaseService ?? createMockDatabaseService()) as any,
        (overrides.userRepository ?? createMockUserRepository()) as any,
        (overrides.userRoleAssignmentRepository ?? {}) as any,
        (overrides.roleRepository ?? {}) as any,
        (overrides.tenantRepository ?? createMockTenantRepository()) as any,
        (overrides.clsService ?? createMockClsService()) as any,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthController', () => {
    let controller: AuthController;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // login endpoint
    // =========================================================================
    describe('login', () => {
        const defaultTenant = createTenant();
        const tenantMap = new Map([[defaultTenant.id, defaultTenant]]);

        function tenantRepo() {
            return createMockTenantRepository(tenantMap);
        }

        it('should throw UnauthorizedException for incorrect password', async () => {
            const hashedPassword = await bcrypt.hash('correct-pass', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'wrong-pass', tenantKey: 'acme-hospital' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should include user roles and permissions in response', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const doctorRole = createRole('doctor', ['read:consultation', 'write:consultation']);
            const nurseRole = createRole('nurse', ['read:consultation']);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([
                    { Role: doctorRole },
                    { Role: nurseRole },
                ]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.roles).toEqual(['doctor', 'nurse']);
            expect(result.user.permissions).toEqual(
                expect.arrayContaining(['read:consultation', 'write:consultation']),
            );
        });

        it('should update lastLoginAt and lastActiveAt on successful login', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const mockUserRepo = createMockUserRepository(users);

            controller = buildController({
                userRepository: mockUserRepo,
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(mockUserRepo.update).toHaveBeenCalledWith(
                user.id,
                expect.objectContaining({
                    lastLoginAt: expect.any(Date),
                    lastActiveAt: expect.any(Date),
                }),
            );
        });

        it('should still return success even if timestamp update fails (catch block)', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const mockUserRepo = createMockUserRepository(users);
            mockUserRepo.update.mockRejectedValueOnce(new Error('DB write failed'));

            controller = buildController({
                userRepository: mockUserRepo,
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result).toHaveProperty('token');
            expect(result).toHaveProperty('user');
            expect(result.user.id).toBe('user-001');
        });

        it('should wrap unexpected errors as UnauthorizedException (generic catch)', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const mockAuthService = createMockAuthService();
            mockAuthService.trackAuthentication.mockRejectedValueOnce(
                new Error('unexpected service failure'),
            );

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: mockAuthService,
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should include email from UserProfile in token payload', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({
                password: hashedPassword,
                UserProfile: { email: 'custom@hospital.com' },
            });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.email).toBe('custom@hospital.com');
        });

        it('should handle user with no UserProfile (email defaults to empty string)', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({
                password: hashedPassword,
                UserProfile: null,
            });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.email).toBe('');
        });

        it('should handle getUserPermissions with roles that have no permissions array', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const roleNoPerms = { id: 'role-bare', name: 'bare-role', permissions: undefined };

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: roleNoPerms }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.permissions).toEqual([]);
        });

        it('should include tenantId and tenantKey in response for tenant-scoped user', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: tenantRepo(),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.tenantId).toBe('tenant-001');
            expect(result.user.tenantKey).toBe('acme-hospital');
        });
    });

    // =========================================================================
    // login — tenant validation
    // =========================================================================
    describe('login — tenant validation', () => {
        const defaultTenant = createTenant();
        const tenantMap = new Map([[defaultTenant.id, defaultTenant]]);

        it('should reject non-admin user when tenantKey is missing', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'pass123' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject when tenantKey does not exist in database', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                tenantRepository: createMockTenantRepository(new Map()),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'pass123', tenantKey: 'nonexistent' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject when user has no role assignment for the specified tenant', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }], null),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should allow SUPER_ADMIN to login without tenantKey (global access)', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword, tenantId: null });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([{ Role: createRole('SUPER_ADMIN', ['*']) }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123' },
                createMockRequest(),
            );

            expect(result).toHaveProperty('token');
            expect(result.user.id).toBe('user-001');
            expect(result.user.tenantId).toBe('');
            expect(result.user.tenantKey).toBe('');
        });

        it('should allow SUPER_ADMIN to login with tenantKey to scope to a specific tenant', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword, tenantId: null });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([{ Role: createRole('SUPER_ADMIN', ['*']) }]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result).toHaveProperty('token');
            expect(result.user.tenantId).toBe('tenant-001');
            expect(result.user.tenantKey).toBe('acme-hospital');
        });

        it('should reject SUPER_ADMIN with invalid tenantKey', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword, tenantId: null });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                tenantRepository: createMockTenantRepository(new Map()),
                databaseService: createMockDatabaseService([{ Role: createRole('SUPER_ADMIN', ['*']) }]),
            });

            await expect(
                controller.login(
                    { username: 'dr_smith', password: 'pass123', tenantKey: 'nonexistent' },
                    createMockRequest(),
                ),
            ).rejects.toThrow(BadRequestException);
        });
    });

    // =========================================================================
    // me endpoint
    // =========================================================================
    describe('me', () => {
        it('should return user info for authenticated user', async () => {
            const user = createUser();
            const users = new Map([[user.id, user]]);
            const doctorRole = createRole('doctor');

            controller = buildController({
                clsService: createMockClsService({ id: user.id }),
                userRepository: createMockUserRepository(users),
                databaseService: createMockDatabaseService([{ Role: doctorRole }]),
            });

            const result = await controller.me(createMockRequest());

            expect(result.id).toBe('user-001');
            expect(result.username).toBe('dr_smith');
            expect(result.email).toBe('smith@hospital.com');
        });

        it('should throw UnauthorizedException when no user in CLS context', async () => {
            controller = buildController({
                clsService: createMockClsService(null),
            });

            await expect(controller.me(createMockRequest())).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException when user not found in database', async () => {
            controller = buildController({
                clsService: createMockClsService({ id: 'nonexistent-id' }),
                userRepository: createMockUserRepository(new Map()),
            });

            await expect(controller.me(createMockRequest())).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should include roles and permissions in response', async () => {
            const user = createUser();
            const users = new Map([[user.id, user]]);
            const adminRole = createRole('admin', ['manage:users', 'read:reports']);
            const doctorRole = createRole('doctor', ['read:consultation']);

            controller = buildController({
                clsService: createMockClsService({ id: user.id }),
                userRepository: createMockUserRepository(users),
                databaseService: createMockDatabaseService([
                    { Role: adminRole },
                    { Role: doctorRole },
                ]),
            });

            const result = await controller.me(createMockRequest());

            expect(result.roles).toEqual(['admin', 'doctor']);
            expect(result.permissions).toEqual(
                expect.arrayContaining(['manage:users', 'read:reports', 'read:consultation']),
            );
        });

        it('should handle user with no UserProfile (email defaults to empty string)', async () => {
            const user = createUser({ UserProfile: null });
            const users = new Map([[user.id, user]]);

            controller = buildController({
                clsService: createMockClsService({ id: user.id }),
                userRepository: createMockUserRepository(users),
                databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            });

            const result = await controller.me(createMockRequest());

            expect(result.email).toBe('');
        });

        it('should wrap unexpected errors as UnauthorizedException', async () => {
            const mockUserRepo = createMockUserRepository(new Map());
            mockUserRepo.findFirst.mockRejectedValueOnce(new Error('DB connection lost'));

            controller = buildController({
                clsService: createMockClsService({ id: 'user-001' }),
                userRepository: mockUserRepo,
            });

            await expect(controller.me(createMockRequest())).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    // =========================================================================
    // logout endpoint
    // =========================================================================
    describe('logout', () => {
        it('should return success with message', async () => {
            const mockAuthService = createMockAuthService();

            controller = buildController({
                clsService: createMockClsService({ id: 'user-001' }),
                authService: mockAuthService,
            });

            const result = await controller.logout(createMockRequest());

            expect(result.success).toBe(true);
            expect(result.message).toBe('Successfully logged out');
        });

        it('should track authentication on logout', async () => {
            const mockAuthService = createMockAuthService();

            controller = buildController({
                clsService: createMockClsService({ id: 'user-001' }),
                authService: mockAuthService,
            });

            await controller.logout(createMockRequest('192.168.1.1'));

            expect(mockAuthService.trackAuthentication).toHaveBeenCalledWith('user-001', {
                ip: '192.168.1.1',
                userAgent: 'test-agent',
                endpoint: '/auth/logout',
                method: 'POST',
            });
        });

        it('should still return success when no user in context', async () => {
            const mockAuthService = createMockAuthService();

            controller = buildController({
                clsService: createMockClsService(null),
                authService: mockAuthService,
            });

            const result = await controller.logout(createMockRequest());

            expect(result.success).toBe(true);
            expect(result.message).toBe('Successfully logged out');
            expect(mockAuthService.trackAuthentication).not.toHaveBeenCalled();
        });

        it('should still return success when trackAuthentication throws (catch block)', async () => {
            const mockAuthService = createMockAuthService();
            mockAuthService.trackAuthentication.mockRejectedValueOnce(
                new Error('tracking service down'),
            );

            controller = buildController({
                clsService: createMockClsService({ id: 'user-001' }),
                authService: mockAuthService,
            });

            const result = await controller.logout(createMockRequest());

            expect(result.success).toBe(true);
            expect(result.message).toBe('Successfully logged out');
        });
    });

    // =========================================================================
    // getUserRoles (tested indirectly through login/me)
    // =========================================================================
    describe('getUserRoles (indirect)', () => {
        it('should filter out null roles from role assignments', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const validRole = createRole('doctor');
            const tenant = createTenant();

            const mockDbService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn(async () => [
                            { Role: validRole },
                            { Role: null },
                            { Role: undefined },
                        ]),
                        findFirst: vi.fn(async () => ({ id: 'ura-1' })),
                    },
                },
            };

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(new Map([[tenant.id, tenant]])),
                databaseService: mockDbService,
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.roles).toEqual(['doctor']);
        });
    });

    // =========================================================================
    // getUserPermissions (tested indirectly through login/me)
    // =========================================================================
    describe('getUserPermissions (indirect)', () => {
        const tenant = createTenant();
        const tenantMap = new Map([[tenant.id, tenant]]);

        it('should aggregate permissions from multiple roles', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const roleA = createRole('admin', ['manage:users', 'read:reports']);
            const roleB = createRole('doctor', ['read:consultation', 'write:notes']);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([
                    { Role: roleA },
                    { Role: roleB },
                ]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.permissions).toEqual(
                expect.arrayContaining([
                    'manage:users',
                    'read:reports',
                    'read:consultation',
                    'write:notes',
                ]),
            );
            expect(result.user.permissions).toHaveLength(4);
        });

        it('should deduplicate permissions (uses Set)', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const roleA = createRole('admin', ['read:consultation', 'manage:users']);
            const roleB = createRole('doctor', ['read:consultation', 'write:notes']);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([
                    { Role: roleA },
                    { Role: roleB },
                ]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            const permissionCounts = result.user.permissions.reduce(
                (acc: Record<string, number>, p: string) => {
                    acc[p] = (acc[p] || 0) + 1;
                    return acc;
                },
                {},
            );

            Object.values(permissionCounts).forEach((count) => {
                expect(count).toBe(1);
            });
            expect(result.user.permissions).toContain('read:consultation');
            expect(result.user.permissions).toContain('manage:users');
            expect(result.user.permissions).toContain('write:notes');
        });

        it('should handle roles with null/undefined permissions', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const roleNull = { id: 'role-null', name: 'null-perms', permissions: null };
            const roleUndefined = { id: 'role-undef', name: 'undef-perms', permissions: undefined };
            const roleValid = createRole('doctor', ['read:consultation']);

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([
                    { Role: roleNull },
                    { Role: roleUndefined },
                    { Role: roleValid },
                ]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.permissions).toEqual(['read:consultation']);
        });

        it('should return empty array when no roles have permissions', async () => {
            const hashedPassword = await bcrypt.hash('pass123', 10);
            const user = createUser({ password: hashedPassword });
            const users = new Map([[user.id, user]]);
            const roleEmpty = { id: 'role-empty', name: 'empty', permissions: [] };
            const roleNull = { id: 'role-null', name: 'null-perms', permissions: null };

            controller = buildController({
                userRepository: createMockUserRepository(users),
                authService: createMockAuthService(),
                tenantRepository: createMockTenantRepository(tenantMap),
                databaseService: createMockDatabaseService([
                    { Role: roleEmpty },
                    { Role: roleNull },
                ]),
            });

            const result = await controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result.user.permissions).toEqual([]);
        });
    });
});
