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
import { EventTypes } from '@arcaai/domains';
import { AuthController } from '../auth.controller';
import { ImpersonationEvents, ImpersonationDeniedReason } from '../impersonation-events';

const SWAGGER_API_OPERATION = 'swagger/apiOperation';

const SUPER_ADMIN = 'SUPER_ADMIN';
const GLOBAL_ADMIN = 'GLOBAL_ADMIN';
const TENANT_ADMIN = 'TENANT_ADMIN';
const DOCTOR = 'doctor';

interface ClsUserStub {
    id: string;
    tenantId?: string | null;
    impersonatedBy?: string;
    jti?: string;
    exp?: number;
}

/** Decode the (unverified) payload segment of a signed JWT for claim assertions. */
function decodeJwtPayload(token: string): Record<string, unknown> {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
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

// TASK-307 W2.3 — AuthController now reads JWT_SECRET_KEY exclusively
// from SecretsService. Tests inject this mock as the 12th constructor
// arg.
function createMockSecrets() {
    return {
        getSecretSync: vi.fn((key: string) =>
            key === 'JWT_SECRET_KEY' ? 'test-secret-key' : undefined,
        ),
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
    targetAssignments: Array<{ tenantId: string | null }>; // pre-W6.1: findMany result; W6.1+: input for findActiveTenantIdsForUser
}

/**
 * TASK-307 W6.1 — replaces the previous `createMockDatabaseService` helper.
 * Same `DatabaseFixture` shape (so existing test setups stay unchanged); the
 * three methods of `IUserRoleAssignmentService` mirror the prior raw-Prisma
 * answer shapes:
 *   - `findActiveRolesForUser` ⇐ prior `findMany({include:{Role:true}})`
 *   - `findActiveTenantIdsForUser` ⇐ prior `findMany({select:{tenantId:true}})`
 *   - `findActiveAssignmentForUserInTenant` ⇐ prior `findFirst` (unused here;
 *     impersonation never exercised it — kept for parity with the interface).
 */
function createMockUserRoleAssignmentService(fixture: DatabaseFixture) {
    return {
        findActiveRolesForUser: vi.fn(async (userId: string) => {
            const roles = userId === 'admin-A'
                ? fixture.adminRoles
                : userId === 'target-B'
                    ? fixture.targetRoles
                    : [];
            return roles.map((name) => ({ id: `role-${name}`, name, permissions: [] }));
        }),
        findActiveTenantIdsForUser: vi.fn(async () => {
            const seen = new Set<string>();
            const ordered: string[] = [];
            for (const row of fixture.targetAssignments) {
                const tenantId = row.tenantId;
                if (typeof tenantId !== 'string' || tenantId.length === 0) continue;
                if (seen.has(tenantId)) continue;
                seen.add(tenantId);
                ordered.push(tenantId);
            }
            return ordered;
        }),
        findActiveAssignmentForUserInTenant: vi.fn(async () => null),
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
    // TASK-331 F-9 — impersonate() resolves the target's primary department for
    // the active tenant via this service; default returns a stub assignment id.
    userDepartmentService?: { findActiveDepartmentForUserInTenant: ReturnType<typeof vi.fn> };
}) {
    const cls = createMockCls(opts.user);
    const userRepository = createMockUserRepository(
        opts.target ?? { id: 'target-B', username: 'doctor.bob', UserProfile: { email: 'bob@x' } },
    );
    const appSettingsService = createMockAppSettings();
    const authService = createMockAuthService();
    const userRoleAssignmentService = createMockUserRoleAssignmentService(
        opts.fixture ?? {
            adminRoles: [TENANT_ADMIN],
            targetRoles: [DOCTOR],
            targetAssignments: [{ tenantId: 'tenant-B' }],
        },
    );
    const jwtRevocationService =
        opts.jwtRevocationService ?? { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) };
    const streamTicketService = { issueTicket: vi.fn(), consumeTicket: vi.fn() };

    const secretsService = createMockSecrets();
    const refreshTokenService = { issue: vi.fn(), consume: vi.fn(), revokeFamily: vi.fn() };
    const userDepartmentService =
        opts.userDepartmentService ?? { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'ud-default' })) };
    // TASK-331 M-3 — AuthController emits the impersonation start/stop bracket
    // through EventEmitter2 (globally provided in prod via EventEmitterModule).
    const eventEmitter = { emit: vi.fn() };
    const controller = new AuthController(
        {} as never, // userService
        authService as never,
        appSettingsService as never,
        userRoleAssignmentService as never,
        userRepository as never,
        {} as never, // userRoleAssignmentRepository
        {} as never, // roleRepository
        {} as never, // tenantRepository
        cls as never,
        streamTicketService as never,
        jwtRevocationService as never,
        secretsService as never,
        refreshTokenService as never,
        userDepartmentService as never,
        eventEmitter as never,
    );
    return {
        controller,
        cls,
        jwtRevocationService,
        userRoleAssignmentService,
        userRepository,
        authService,
        userDepartmentService,
        eventEmitter,
    };
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

    // ─── F-4: GLOBAL_ADMIN is a SUPER_ADMIN synonym for impersonation ────────
    describe('impersonate — F-4 GLOBAL_ADMIN parity with SUPER_ADMIN', () => {
        it('allows GLOBAL_ADMIN to impersonate cross-tenant (like SUPER_ADMIN)', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [GLOBAL_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.tenantId).toBe('tenant-B');
            expect(response.impersonatedBy).toBe('admin-A');
        });

        it('blocks impersonating a GLOBAL_ADMIN target (treated like a SUPER_ADMIN target)', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [GLOBAL_ADMIN],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
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

    // ─── F-8: unpredictable impersonation jti ────────────────────────────────
    describe('impersonate — F-8 jti hygiene', () => {
        it('mints a fresh unpredictable jti (prefixed "impersonate-") on every call for the same admin+target', async () => {
            const makeController = () =>
                buildController({
                    user: { id: 'admin-A', tenantId: 'tenant-A' },
                    fixture: {
                        adminRoles: [SUPER_ADMIN],
                        targetRoles: [DOCTOR],
                        targetAssignments: [{ tenantId: 'tenant-B' }],
                    },
                }).controller;

            const first = await makeController().impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );
            const second = await makeController().impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            const jti1 = decodeJwtPayload(first.token).jti as string;
            const jti2 = decodeJwtPayload(second.token).jti as string;

            expect(jti1).toMatch(/^impersonate-/);
            expect(jti2).toMatch(/^impersonate-/);
            expect(jti1).not.toBe(jti2);
            // The suffix must not leak the admin/target ids (the legacy shape did).
            expect(jti1).not.toContain('admin-A');
            expect(jti1).not.toContain('target-B');
        });
    });

    // ─── F-9: impersonate response carries the target's departmentId ─────────
    describe('impersonate — F-9 departmentId in response', () => {
        it("includes the target user's primary department id resolved for the impersonation tenant", async () => {
            const { controller, userDepartmentService } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
                userDepartmentService: {
                    findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'dept-doctor-001' })),
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.departmentId).toBe('dept-doctor-001');
            expect(userDepartmentService.findActiveDepartmentForUserInTenant).toHaveBeenCalledWith('target-B', 'tenant-B');
        });

        it('leaves departmentId undefined when the target has no active department in the tenant', async () => {
            const { controller } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
                userDepartmentService: {
                    findActiveDepartmentForUserInTenant: vi.fn(async () => null),
                },
            });

            const response = await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '127.0.0.1', headers: {} } as never,
            );

            expect(response.user.departmentId).toBeUndefined();
        });
    });

    // ─── M-3: explicit impersonation start/stop audit bracket ────────────────
    describe('impersonate/revoke — M-3 lifecycle audit emission', () => {
        it('emits UserAuthenticated with phase START on impersonate', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: {
                    adminRoles: [SUPER_ADMIN],
                    targetRoles: [DOCTOR],
                    targetAssignments: [{ tenantId: 'tenant-B' }],
                },
            });

            await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never,
            );

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'admin-A',
                    impersonatedUserId: 'target-B',
                    phase: 'START',
                    endpoint: '/auth/impersonate',
                    method: 'POST',
                }),
            );
        });

        it('emits UserAuthenticated with phase STOP on revoke-impersonation', async () => {
            const { controller, eventEmitter } = buildController({
                user: {
                    id: 'doctor-001',
                    impersonatedBy: 'admin-007',
                    jti: 'impersonate-deadbeef',
                    exp: Math.floor(Date.now() / 1000) + 600,
                },
            });

            await controller.revokeImpersonation({ ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                EventTypes.UserAuthenticated,
                expect.objectContaining({
                    userId: 'admin-007',
                    impersonatedUserId: 'doctor-001',
                    phase: 'STOP',
                    endpoint: '/auth/revoke-impersonation',
                    method: 'POST',
                }),
            );
        });
    });

    // ─── AC-11 (TASK-336): dedicated impersonation events + denial audit ──────
    // The legacy `UserAuthenticated` phase bracket is preserved (above); these
    // dedicated, semantically named events are emitted IN ADDITION and, unlike
    // the success-only bracket, also record DENIED attempts.
    describe('AC-11 — dedicated impersonation audit events', () => {
        it('emits ImpersonationEvents.Started (success) on a successful impersonate', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: { adminRoles: [SUPER_ADMIN], targetRoles: [DOCTOR], targetAssignments: [{ tenantId: 'tenant-B' }] },
            });

            await controller.impersonate(
                { targetUserId: 'target-B' } as never,
                { ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never,
            );

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                ImpersonationEvents.Started,
                expect.objectContaining({ adminId: 'admin-A', targetUserId: 'target-B', tenantId: 'tenant-B', success: true }),
            );
        });

        it('emits ImpersonationEvents.Ended (success) on revoke-impersonation', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'doctor-001', impersonatedBy: 'admin-007', jti: 'impersonate-deadbeef', exp: Math.floor(Date.now() / 1000) + 600 },
            });

            await controller.revokeImpersonation({ ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                ImpersonationEvents.Ended,
                expect.objectContaining({ adminId: 'admin-007', targetUserId: 'doctor-001', success: true }),
            );
        });

        it('records a denial when a TENANT_ADMIN impersonates a user in another tenant (CROSS_TENANT_DENIED)', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: { adminRoles: [TENANT_ADMIN], targetRoles: [DOCTOR], targetAssignments: [{ tenantId: 'tenant-B' }] },
            });

            await expect(
                controller.impersonate({ targetUserId: 'target-B' } as never, { ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never),
            ).rejects.toBeInstanceOf(ForbiddenException);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                ImpersonationEvents.Denied,
                expect.objectContaining({
                    adminId: 'admin-A',
                    targetUserId: 'target-B',
                    success: false,
                    reason: ImpersonationDeniedReason.CrossTenantDenied,
                }),
            );
        });

        it('records a denial when the target is a super-admin (TARGET_IS_SUPER_ADMIN)', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: { adminRoles: [SUPER_ADMIN], targetRoles: [SUPER_ADMIN], targetAssignments: [{ tenantId: 'tenant-A' }] },
            });

            await expect(
                controller.impersonate({ targetUserId: 'target-B' } as never, { ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                ImpersonationEvents.Denied,
                expect.objectContaining({
                    adminId: 'admin-A',
                    targetUserId: 'target-B',
                    success: false,
                    reason: ImpersonationDeniedReason.TargetIsSuperAdmin,
                }),
            );
        });

        it('records a denial when a non-admin attempts to impersonate (CALLER_NOT_ADMIN)', async () => {
            const { controller, eventEmitter } = buildController({
                user: { id: 'admin-A', tenantId: 'tenant-A' },
                fixture: { adminRoles: [DOCTOR], targetRoles: [DOCTOR], targetAssignments: [{ tenantId: 'tenant-A' }] },
            });

            await expect(
                controller.impersonate({ targetUserId: 'target-B' } as never, { ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as never),
            ).rejects.toBeInstanceOf(UnauthorizedException);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                ImpersonationEvents.Denied,
                expect.objectContaining({ adminId: 'admin-A', targetUserId: 'target-B', success: false, reason: ImpersonationDeniedReason.CallerNotAdmin }),
            );
        });
    });

    // ─── AC-08 (TASK-336): Swagger description matches actual behaviour ───────
    describe('AC-08 — impersonate Swagger description accuracy', () => {
        it('documents that SUPER_ADMIN can impersonate a TENANT_ADMIN and only super-admin targets are blocked', () => {
            const op = Reflect.getMetadata(SWAGGER_API_OPERATION, AuthController.prototype.impersonate);
            expect(op).toBeDefined();
            expect(op.description).toBeDefined();
            expect(op.description).toMatch(/TENANT_ADMIN/);
            expect(op.description).toMatch(/SUPER_ADMIN|GLOBAL_ADMIN/);
        });
    });
});
