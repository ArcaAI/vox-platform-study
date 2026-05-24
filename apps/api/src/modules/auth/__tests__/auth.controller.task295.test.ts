/**
 * AuthController — TASK-295 backend impersonation security tests.
 *
 * Covers:
 *   - C-1: TENANT_ADMIN(A) → DOCTOR(B) must be rejected with ForbiddenException.
 *   - H-3: optional `targetTenantId` validation.
 *   - L-3: `revoke-impersonation` rejects callers that are not impersonating.
 *   - C-4: `revoke-impersonation` calls JwtRevocationService.revoke with (jti, exp).
 *
 * Keeps mocks lightweight — pure unit test, no Nest container.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../auth.controller';

const SUPER_ADMIN = 'SUPER_ADMIN';
const TENANT_ADMIN = 'TENANT_ADMIN';
const DOCTOR = 'doctor';

interface ClsUserStub {
    id: string;
    tenantId?: string | null;
    impersonatedBy?: string;
    jti?: string;
    exp?: number;
}

function createMockCls(user: ClsUserStub | null) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'user') return user;
            if (key === 'tenantId') return user?.tenantId ?? null;
            return null;
        }),
        set: vi.fn(),
    };
}

function createMockUserRepository(target: { id: string; username?: string; UserProfile?: { email?: string } } | null) {
    return {
        findFirst: vi.fn(async () => target),
        update: vi.fn(),
    };
}

function createMockAppSettings() {
    return {
        getValueWithDefault: vi.fn((_key: string, fallback: string) => fallback),
    };
}

function createMockAuthService() {
    return {
        trackAuthentication: vi.fn().mockResolvedValue(undefined),
    };
}

interface DatabaseFixture {
    adminRoles: string[]; // role names of the admin user
    targetRoles: string[]; // role names of the impersonation target
    targetAssignments: Array<{ tenantId: string | null }>; // findMany result
}

function createMockDatabaseService(fixture: DatabaseFixture) {
    const userRoleAssignment = {
        findMany: vi.fn(async (args: any) => {
            // The controller calls findMany twice with different shapes:
            // 1) getUserRoles(adminId) and getUserRoles(targetId) — both `include: { Role: true }`
            // 2) the H-3 tenant lookup — `select: { tenantId: true }`
            if (args?.select?.tenantId) {
                return fixture.targetAssignments;
            }
            // Role lookup — match by userId in `where`
            const userId = args?.where?.userId;
            const roles = userId === 'admin-A'
                ? fixture.adminRoles
                : userId === 'target-B'
                    ? fixture.targetRoles
                    : [];
            return roles.map((name) => ({ Role: { name, permissions: [] } }));
        }),
        findFirst: vi.fn(),
    };
    return {
        client: { userRoleAssignment },
    };
}

function buildController(opts: {
    user: ClsUserStub | null;
    target?: { id: string; username?: string; UserProfile?: { email?: string } } | null;
    fixture?: DatabaseFixture;
    jwtRevocationService?: {
        revoke: ReturnType<typeof vi.fn>;
        isRevoked: ReturnType<typeof vi.fn>;
    };
}) {
    const cls = createMockCls(opts.user);
    const userRepository = createMockUserRepository(
        opts.target ?? { id: 'target-B', username: 'doctor.bob', UserProfile: { email: 'bob@x' } },
    );
    const appSettingsService = createMockAppSettings();
    const authService = createMockAuthService();
    const databaseService = createMockDatabaseService(
        opts.fixture ?? {
            adminRoles: [TENANT_ADMIN],
            targetRoles: [DOCTOR],
            targetAssignments: [{ tenantId: 'tenant-B' }],
        },
    );
    const jwtRevocationService =
        opts.jwtRevocationService ?? { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) };
    const streamTicketService = { issueTicket: vi.fn(), consumeTicket: vi.fn() };

    const controller = new AuthController(
        {} as never, // userService
        authService as never,
        appSettingsService as never,
        databaseService as never,
        userRepository as never,
        {} as never, // userRoleAssignmentRepository
        {} as never, // roleRepository
        {} as never, // tenantRepository
        cls as never,
        streamTicketService as never,
        jwtRevocationService as never,
    );
    return { controller, cls, jwtRevocationService, databaseService, userRepository, authService };
}

describe('AuthController — TASK-295 impersonation security', () => {
    beforeEach(() => vi.clearAllMocks());

    // ─── C-1: cross-tenant block ─────────────────────────────────────────────
    describe('impersonate — C-1 tenant scope enforcement', () => {
        it('throws ForbiddenException when TENANT_ADMIN(A) tries to impersonate DOCTOR in tenant B', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [TENANT_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
            });

            await expect(
                controller.impersonate(
                    { targetUserId: 'target-B' } as never,
                    { ip: '127.0.0.1', headers: {} } as never,
                ),
            ).rejects.toThrow(ForbiddenException);
        });

        it('throws ForbiddenException when TENANT_ADMIN(A) explicitly targets tenant B via targetTenantId', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [TENANT_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-A' }, { tenantId: 'tenant-B' }],
                },
            });

            await expect(
                controller.impersonate(
                    { targetUserId: 'target-B', targetTenantId: 'tenant-B' } as never,
                    { ip: '127.0.0.1', headers: {} } as never,
                ),
            ).rejects.toThrow(ForbiddenException);
        });

        it('allows TENANT_ADMIN(A) to impersonate a user whose tenant is also A', async () => {
            const { controller, authService } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [TENANT_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-A' }],
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.tenantId).toBe('tenant-A');
            expect(response.impersonatedBy).toBe('admin-A');
            expect(authService.trackAuthentication).toHaveBeenCalled();
        });

        it('allows SUPER_ADMIN to impersonate cross-tenant', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.tenantId).toBe('tenant-B');
        });
    });

    // ─── H-3: optional targetTenantId ────────────────────────────────────────
    describe('impersonate — H-3 targetTenantId validation', () => {
        it('rejects when targetTenantId is not in the target user\'s enabled assignments', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-A' }],
                },
            });

            await expect(
                controller.impersonate(
                    { targetUserId: 'target-B', targetTenantId: 'tenant-Z' } as never,
                    { ip: '127.0.0.1', headers: {} } as never,
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('honours the supplied targetTenantId when valid (SUPER_ADMIN, multi-tenant target)', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-A' }, { tenantId: 'tenant-B' }],
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B', targetTenantId: 'tenant-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.tenantId).toBe('tenant-B');
        });

        it('rejects when the target has no enabled tenant assignments at all', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [],
                },
            });

            await expect(
                controller.impersonate(
                    { targetUserId: 'target-B' } as never,
                    { ip: '127.0.0.1', headers: {} } as never,
                ),
            ).rejects.toThrow(BadRequestException);
        });
    });

    // ─── L-3 / C-4: revoke-impersonation ─────────────────────────────────────
    describe('revokeImpersonation — L-3 + C-4', () => {
        it('rejects with BadRequestException when caller is not currently impersonating (L-3)', async () => {
            const { controller, jwtRevocationService } = buildController({
                user: { id: 'user-1' /* no impersonatedBy */ },
            });

            await expect(
                controller.revokeImpersonation({ ip: '127.0.0.1', headers: {} } as never),
            ).rejects.toThrow(BadRequestException);
            expect(jwtRevocationService.revoke).not.toHaveBeenCalled();
        });

        it('calls jwtRevocationService.revoke(jti, exp) when impersonating (C-4)', async () => {
            const { controller, jwtRevocationService } = buildController({
                user: {
                    id: 'doctor-001',
                    impersonatedBy: 'admin-007',
                    jti: 'impersonate-admin-007-doctor-001-1700',
                    exp: Math.floor(Date.now() / 1000) + 600,
                },
            });

            const result = await controller.revokeImpersonation({ ip: '127.0.0.1', headers: {} } as never);

            expect(jwtRevocationService.revoke).toHaveBeenCalledWith(
                'impersonate-admin-007-doctor-001-1700',
                expect.any(Number),
            );
            expect(result).toEqual({ success: true });
        });

        it('throws UnauthorizedException when no user in CLS', async () => {
            const { controller, jwtRevocationService } = buildController({ user: null });

            await expect(
                controller.revokeImpersonation({ ip: '127.0.0.1', headers: {} } as never),
            ).rejects.toThrow(UnauthorizedException);
            expect(jwtRevocationService.revoke).not.toHaveBeenCalled();
        });

        it('still succeeds (no-op revoke) when impersonatedBy is set but jti is missing', async () => {
            const { controller, jwtRevocationService } = buildController({
                user: { id: 'doctor-001', impersonatedBy: 'admin-007' /* no jti */ },
            });

            const result = await controller.revokeImpersonation({ ip: '127.0.0.1', headers: {} } as never);
            expect(result).toEqual({ success: true });
            expect(jwtRevocationService.revoke).not.toHaveBeenCalled();
        });
    });
});
