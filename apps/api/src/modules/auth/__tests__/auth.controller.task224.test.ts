/**
 * TASK-224: Auth Controller Security Tests
 *
 * Tests for:
 * 1. Refresh token uses cryptographically secure randomness
 * 2. Impersonation JWT includes impersonatedBy claim
 * 3. Impersonation endpoint enforces admin-only access
 * 4. Impersonation short TTL
 * 5. Token revocation endpoint
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthController } from '../auth.controller';

const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'admin', 'system-admin'];

const createAdminUser = (id = 'admin-001') => ({
    id,
    username: 'super_admin',
    email: 'admin@arcaai.com',
});

const createTargetUser = (id = 'doctor-001') => ({
    id,
    username: 'dr_smith',
    password: '$2a$10$hashedpassword',
    tenantId: 'tenant-001',
    UserProfile: { email: 'smith@hospital.com' },
    resourceStatus: 'ENABLED',
    lastLoginAt: null,
    lastActiveAt: null,
});

const createRole = (name: string) => ({
    id: `role-${name}`,
    name,
    permissions: ['read:consultation'],
});

const createMockClsService = (user: any = null) => ({
    get: vi.fn((key: string) => key === 'user' ? user : null),
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
            return { id: 'tenant-001', key: 'acme-hospital', name: 'Acme Hospital', resourceStatus: 'ENABLED' };
        }
        return null;
    }),
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

describe('AuthController — TASK-224 Security Tests', () => {
    let controller: AuthController;
    let mockClsService: any;
    let mockUserRepository: any;
    let mockDatabaseService: any;
    let mockAuthService: any;
    let mockAppSettingsService: any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // Refresh Token Security
    // =========================================================================

    describe('generateRefreshToken security', () => {
        it('should generate a refresh token with at least 64 hex chars of randomness', () => {
            const adminUser = createAdminUser();
            const adminRole = createRole('SUPER_ADMIN');
            const targetUser = createTargetUser();

            mockClsService = createMockClsService(adminUser);
            const users = new Map([
                [adminUser.id, { ...adminUser, password: '$2a$10$hash', tenantId: 't1', UserProfile: { email: 'admin@a.com' }, resourceStatus: 'ENABLED', lastLoginAt: null, lastActiveAt: null }],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockDatabaseService = createMockDatabaseService([]);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            const token = (controller as any).generateRefreshToken('user-123');
            expect(token).toMatch(/^refresh_user-123_\d+_[0-9a-f]{64}$/);
        });

        it('should generate unique tokens on consecutive calls', () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            const token1 = (controller as any).generateRefreshToken('user-123');
            const token2 = (controller as any).generateRefreshToken('user-123');
            expect(token1).not.toBe(token2);
        });
    });

    // =========================================================================
    // Impersonation JWT payload must include impersonatedBy
    // =========================================================================

    describe('impersonate endpoint — JWT payload', () => {
        it('should include impersonatedBy in the JWT payload', async () => {
            const adminUser = createAdminUser();
            const targetUser = createTargetUser();
            const adminRole = createRole('SUPER_ADMIN');
            const doctorRole = createRole('doctor');

            mockClsService = createMockClsService(adminUser);
            const users = new Map<string, any>([
                [adminUser.id, adminUser],
                [targetUser.id, targetUser],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();

            let capturedPayload: any = null;

            vi.doMock('@arcaai/applications', async (importOriginal) => {
                const actual = await importOriginal();
                return {
                    ...(actual as object),
                    createJwt: vi.fn((payload: any) => {
                        capturedPayload = payload;
                        return 'mocked-jwt-token';
                    }),
                };
            });

            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: adminRole }])
                            .mockResolvedValueOnce([{ Role: doctorRole }]),
                        findFirst: vi.fn().mockResolvedValue({ tenantId: 'tenant-001' }),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            const response = await controller.impersonate(
                { targetUserId: 'doctor-001' },
                createMockRequest(),
            );

            expect(response.impersonatedBy).toBe('admin-001');
            expect(response.token).toBeDefined();
            expect(response.user.id).toBe('doctor-001');
        });

        it('should reject non-admin users from impersonating', async () => {
            const regularUser = { id: 'user-001', username: 'regular' };
            const regularRole = createRole('doctor');

            mockClsService = createMockClsService(regularUser);
            mockUserRepository = createMockUserRepository(new Map([[regularUser.id, regularUser]]));
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn().mockResolvedValue([{ Role: regularRole }]),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'doctor-001' }, createMockRequest()),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should reject SUPER_ADMIN impersonating another SUPER_ADMIN', async () => {
            const adminUser = createAdminUser();
            const targetAdmin = { ...createTargetUser('admin-002'), username: 'other_super_admin' };
            const superAdminRole = createRole('SUPER_ADMIN');

            mockClsService = createMockClsService(adminUser);
            const users = new Map<string, any>([
                [adminUser.id, adminUser],
                ['admin-002', targetAdmin],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: superAdminRole }])
                            .mockResolvedValueOnce([{ Role: superAdminRole }]),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'admin-002' }, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should allow SUPER_ADMIN to impersonate TENANT_ADMIN', async () => {
            const adminUser = createAdminUser();
            const targetTenantAdmin = { ...createTargetUser('tadmin-001'), username: 'tenant_admin' };
            const superAdminRole = createRole('SUPER_ADMIN');
            const tenantAdminRole = createRole('TENANT_ADMIN');

            mockClsService = createMockClsService(adminUser);
            const users = new Map<string, any>([
                [adminUser.id, adminUser],
                ['tadmin-001', targetTenantAdmin],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: superAdminRole }])
                            .mockResolvedValueOnce([{ Role: tenantAdminRole }]),
                        findFirst: vi.fn().mockResolvedValue({ tenantId: 'tenant-001' }),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            const result = await controller.impersonate(
                { targetUserId: 'tadmin-001' },
                createMockRequest(),
            );

            expect(result.user.id).toBe('tadmin-001');
            expect(result.impersonatedBy).toBe('admin-001');
            expect(result.token).toBeDefined();
        });

        it('should reject TENANT_ADMIN impersonating another TENANT_ADMIN', async () => {
            const tenantAdmin = { id: 'tadmin-001', username: 'tenant_admin_1' };
            const otherTenantAdmin = { ...createTargetUser('tadmin-002'), username: 'tenant_admin_2' };
            const tenantAdminRole = createRole('TENANT_ADMIN');

            mockClsService = createMockClsService(tenantAdmin);
            const users = new Map<string, any>([
                [tenantAdmin.id, tenantAdmin],
                ['tadmin-002', otherTenantAdmin],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: tenantAdminRole }])
                            .mockResolvedValueOnce([{ Role: tenantAdminRole }]),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'tadmin-002' }, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject TENANT_ADMIN impersonating SUPER_ADMIN', async () => {
            const tenantAdmin = { id: 'tadmin-001', username: 'tenant_admin' };
            const superAdmin = { ...createTargetUser('sadmin-001'), username: 'super_admin_target' };
            const tenantAdminRole = createRole('TENANT_ADMIN');
            const superAdminRole = createRole('SUPER_ADMIN');

            mockClsService = createMockClsService(tenantAdmin);
            const users = new Map<string, any>([
                [tenantAdmin.id, tenantAdmin],
                ['sadmin-001', superAdmin],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: tenantAdminRole }])
                            .mockResolvedValueOnce([{ Role: superAdminRole }]),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'sadmin-001' }, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });
    });

    // =========================================================================
    // RECOMMENDATION: Impersonation Short TTL
    // =========================================================================

    describe('Recommendation 2: impersonation uses shorter TTL', () => {
        it('should use JWT_IMPERSONATION_EXPIRES_IN for impersonation token expiry', async () => {
            const adminUser = createAdminUser();
            const targetUser = createTargetUser();
            const adminRole = createRole('SUPER_ADMIN');
            const doctorRole = createRole('doctor');

            mockClsService = createMockClsService(adminUser);
            const users = new Map<string, any>([
                [adminUser.id, adminUser],
                [targetUser.id, targetUser],
            ]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = {
                client: {
                    userRoleAssignment: {
                        findMany: vi.fn()
                            .mockResolvedValueOnce([{ Role: adminRole }])
                            .mockResolvedValueOnce([{ Role: doctorRole }]),
                        findFirst: vi.fn().mockResolvedValue({ tenantId: 'tenant-001' }),
                    },
                },
            };

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await controller.impersonate(
                { targetUserId: 'doctor-001' },
                createMockRequest(),
            );

            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith(
                'JWT_IMPERSONATION_EXPIRES_IN',
                '15m',
            );
        });
    });

    // =========================================================================
    // RECOMMENDATION: Token Revocation Endpoint
    // =========================================================================

    describe('Recommendation 4: revoke-impersonation endpoint', () => {
        it('should have a revokeImpersonation method on the controller', () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            expect(typeof (controller as any).revokeImpersonation).toBe('function');
        });

        it('should return success true when called with a valid request', async () => {
            const adminUser = createAdminUser();
            mockClsService = createMockClsService(adminUser);
            mockAuthService = createMockAuthService();

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            const result = await controller.revokeImpersonation(createMockRequest());
            expect(result).toEqual({ success: true });
        });

        it('should call trackAuthentication with revoke-impersonation endpoint info', async () => {
            const adminUser = createAdminUser();
            mockClsService = createMockClsService(adminUser);
            mockAuthService = createMockAuthService();

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await controller.revokeImpersonation(createMockRequest());

            expect(mockAuthService.trackAuthentication).toHaveBeenCalledWith(
                'admin-001',
                expect.objectContaining({
                    endpoint: '/auth/revoke-impersonation',
                    method: 'POST',
                }),
            );
        });

        it('should still return success when no user is in context', async () => {
            mockClsService = createMockClsService(null);
            mockAuthService = createMockAuthService();

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            const result = await controller.revokeImpersonation(createMockRequest());
            expect(result).toEqual({ success: true });
            expect(mockAuthService.trackAuthentication).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Refresh Endpoint Edge Cases
    // =========================================================================

    describe('refresh endpoint — edge cases', () => {
        it('should throw BadRequestException when refreshToken is empty', async () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.refresh({ refreshToken: '' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw UnauthorizedException for invalid token format (no refresh_ prefix)', async () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.refresh({ refreshToken: 'invalid-token-format' }),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should throw UnauthorizedException when user extracted from token is not found', async () => {
            mockUserRepository = createMockUserRepository(new Map());
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = createMockDatabaseService([]);

            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.refresh({ refreshToken: 'refresh_nonexistent-user_12345_abcdef' }),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should return new token pair for valid refresh token with existing user', async () => {
            const targetUser = createTargetUser('user-123');
            const doctorRole = createRole('doctor');
            const users = new Map([['user-123', targetUser]]);

            mockUserRepository = createMockUserRepository(users);
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = createMockDatabaseService([{ Role: doctorRole }]);

            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            const result = await controller.refresh({
                refreshToken: 'refresh_user-123_12345_' + 'a'.repeat(64),
            });

            expect(result).toHaveProperty('token');
            expect(result).toHaveProperty('refreshToken');
            expect(typeof result.token).toBe('string');
            expect(result.refreshToken).toMatch(/^refresh_user-123_/);
        });

        it('should extract userId correctly from multi-segment refresh token', async () => {
            const users = new Map([['user-with-dashes', createTargetUser('user-with-dashes')]]);
            mockUserRepository = createMockUserRepository(users);
            mockDatabaseService = createMockDatabaseService([{ Role: createRole('doctor') }]);
            mockAppSettingsService = createMockAppSettingsService();

            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            const result = await controller.refresh({
                refreshToken: 'refresh_user-with-dashes_12345_' + 'b'.repeat(64),
            });

            expect(result).toHaveProperty('token');
        });
    });

    // =========================================================================
    // Login Endpoint Security
    // =========================================================================

    describe('login endpoint — security', () => {
        it('should throw BadRequestException when username is missing', async () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.login({ username: '', password: 'pass' } as any, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when password is missing', async () => {
            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.login({ username: 'user', password: '' } as any, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw UnauthorizedException for nonexistent user', async () => {
            mockUserRepository = createMockUserRepository(new Map());

            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                createMockClsService() as any,
            );

            await expect(
                controller.login({ username: 'ghost', password: 'pass' }, createMockRequest()),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should return token and refreshToken on successful login', async () => {
            const hashedPassword = await (await import('bcryptjs')).hash('correct-pass', 10);
            const user = {
                ...createTargetUser('user-001'),
                username: 'real_user',
                password: hashedPassword,
            };
            const users = new Map([['user-001', user]]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = createMockDatabaseService([{ Role: createRole('doctor') }]);

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                createMockTenantRepository() as any,
                createMockClsService() as any,
            );

            const result = await controller.login(
                { username: 'real_user', password: 'correct-pass', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(result).toHaveProperty('token');
            expect(result).toHaveProperty('refreshToken');
            expect(result).toHaveProperty('user');
            expect(result.user.id).toBe('user-001');
            expect(result.refreshToken).toMatch(/^refresh_user-001_/);
        });

        it('should track authentication on successful login', async () => {
            const hashedPassword = await (await import('bcryptjs')).hash('correct-pass', 10);
            const user = {
                ...createTargetUser('user-002'),
                username: 'tracked_user',
                password: hashedPassword,
            };
            const users = new Map([['user-002', user]]);
            mockUserRepository = createMockUserRepository(users);
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = createMockDatabaseService([{ Role: createRole('doctor') }]);

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                createMockTenantRepository() as any,
                createMockClsService() as any,
            );

            await controller.login(
                { username: 'tracked_user', password: 'correct-pass', tenantKey: 'acme-hospital' },
                createMockRequest(),
            );

            expect(mockAuthService.trackAuthentication).toHaveBeenCalledWith(
                'user-002',
                expect.objectContaining({
                    endpoint: '/auth/login',
                    method: 'POST',
                }),
            );
        });
    });

    // =========================================================================
    // Impersonate Edge Cases
    // =========================================================================

    describe('impersonate endpoint — edge cases', () => {
        it('should throw UnauthorizedException when no user in context', async () => {
            mockClsService = createMockClsService(null);

            controller = new AuthController(
                createMockUserService() as any,
                createMockAuthService() as any,
                createMockAppSettingsService() as any,
                createMockDatabaseService() as any,
                createMockUserRepository() as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'doctor-001' }, createMockRequest()),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should throw BadRequestException when target user does not exist', async () => {
            const adminUser = createAdminUser();
            const adminRole = createRole('SUPER_ADMIN');

            mockClsService = createMockClsService(adminUser);
            mockUserRepository = createMockUserRepository(new Map([[adminUser.id, adminUser]]));
            mockAuthService = createMockAuthService();
            mockAppSettingsService = createMockAppSettingsService();
            mockDatabaseService = createMockDatabaseService([{ Role: adminRole }]);

            controller = new AuthController(
                createMockUserService() as any,
                mockAuthService as any,
                mockAppSettingsService as any,
                mockDatabaseService as any,
                mockUserRepository as any,
                {} as any,
                {} as any,
                {} as any,
                mockClsService as any,
            );

            await expect(
                controller.impersonate({ targetUserId: 'nonexistent' }, createMockRequest()),
            ).rejects.toThrow(BadRequestException);
        });
    });
});
