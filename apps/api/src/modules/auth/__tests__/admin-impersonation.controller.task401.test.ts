/**
 * AdminImpersonationController — global-admin-only impersonation.
 *
 * Guard matrix, token-claim shape, TTL default/override, and audit emissions
 * for `POST /admin/users/:id/impersonate`. Pure unit tests (no Nest container),
 * mirroring the auth.controller.task295 mock harness.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EventTypes, SysEventType } from '@arcaai/domains';
import { AdminImpersonationController, USER_IMPERSONATION_STARTED } from '../admin-impersonation.controller';
import { ImpersonationEvents, ImpersonationDeniedReason } from '../impersonation-events';

const GLOBAL_ADMIN = 'GLOBAL_ADMIN';
// Retired role literal, used only to prove it no longer elevates.
const RETIRED_SUPER_ADMIN = 'SUPER_ADMIN';
const TENANT_ADMIN = 'TENANT_ADMIN';
const DOCTOR = 'DOCTOR';

interface ClsUserStub {
    id: string;
    tenantId?: string | null;
    impersonatedBy?: string;
}

/** Decode the (unverified) payload segment of a signed JWT for claim assertions. */
function decodeJwtPayload(token: string): Record<string, unknown> {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const REQ = { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } } as never;

interface Fixture {
    actorRoles: string[];
    targetRoles: Array<{ name: string; permissions?: string[] }>;
    targetTenants: string[];
    target?: { id: string; username?: string; resourceStatus?: string; UserProfile?: { email?: string } } | null;
}

function buildController(opts: { user: ClsUserStub | null; fixture?: Partial<Fixture> }) {
    const fixture: Fixture = {
        actorRoles: [GLOBAL_ADMIN],
        targetRoles: [{ name: DOCTOR, permissions: ['read:Consultation'] }],
        targetTenants: ['tenant-B'],
        target: { id: 'target-B', username: 'doctor.bob', resourceStatus: 'ENABLED', UserProfile: { email: 'bob@x' } },
        ...opts.fixture,
    };

    const cls = {
        get: vi.fn((key: string) => {
            if (key === 'user') return opts.user;
            if (key === 'tenantId') return opts.user?.tenantId ?? null;
            if (key === 'correlationId') return 'corr-401';
            return null;
        }),
        set: vi.fn(),
    };
    const userRepository = {
        findFirst: vi.fn(async () => (fixture.target === null ? null : fixture.target)),
    };
    const appSettingsService = {
        getValueWithDefault: vi.fn((_key: string, fallback: string) => fallback),
    };
    const authService = { trackAuthentication: vi.fn().mockResolvedValue(undefined) };
    const userRoleAssignmentService = {
        findActiveRolesForUser: vi.fn(async (userId: string) => {
            if (userId === 'admin-A') return fixture.actorRoles.map((name) => ({ id: `role-${name}`, name, permissions: [] }));
            if (userId === (fixture.target?.id ?? 'target-B')) {
                return fixture.targetRoles.map((r) => ({ id: `role-${r.name}`, name: r.name, permissions: r.permissions ?? [] }));
            }
            return [];
        }),
        findActiveTenantIdsForUser: vi.fn(async () => fixture.targetTenants),
        findActiveAssignmentForUserInTenant: vi.fn(async () => null),
    };
    const userDepartmentService = { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'dept-primary' })) };
    const secretsService = {
        getSecretSync: vi.fn((key: string) => (key === 'JWT_SECRET_KEY' ? 'test-secret-key' : undefined)),
        getSecretOptional: vi.fn(async () => undefined),
    };
    const eventEmitter = { emit: vi.fn() };

    const controller = new AdminImpersonationController(
        authService as never,
        appSettingsService as never,
        userRoleAssignmentService as never,
        userDepartmentService as never,
        userRepository as never,
        cls as never,
        secretsService as never,
        eventEmitter as never,
    );

    return { controller, cls, userRepository, appSettingsService, authService, userRoleAssignmentService, eventEmitter };
}

/** Emitted denial payloads for a given harness. */
function deniedEvents(eventEmitter: { emit: ReturnType<typeof vi.fn> }) {
    return eventEmitter.emit.mock.calls.filter(([name]) => name === ImpersonationEvents.Denied).map(([, payload]) => payload);
}

describe('AdminImpersonationController — TASK-401 guard matrix', () => {
    beforeEach(() => vi.clearAllMocks());

    it('allows a GLOBAL_ADMIN and mints a target-identity token with the actor preserved', async () => {
        const { controller } = buildController({ user: { id: 'admin-A', tenantId: null } });

        const response = await controller.impersonate('target-B', {}, REQ);

        expect(response.impersonatedBy).toBe('admin-A');
        expect(response.user.id).toBe('target-B');
        expect(response.user.tenantId).toBe('tenant-B');
        expect(response.user.departmentId).toBe('dept-primary');

        const claims = decodeJwtPayload(response.token);
        expect(claims.id).toBe('target-B');
        expect(claims.roles).toEqual([DOCTOR]);
        expect(claims.permissions).toEqual(['read:Consultation']);
        expect(claims.tenantId).toBe('tenant-B');
        expect(claims.impersonatedBy).toBe('admin-A');
        expect(String(claims.jti)).toMatch(/^impersonate-[0-9a-f]{32}$/);
        // Non-refreshable: no refresh family is minted for impersonation tokens.
        expect(claims.refreshFamily).toBeUndefined();
    });

    it('defaults the TTL to 30 minutes (JWT_IMPERSONATION_EXPIRES_IN fallback)', async () => {
        const { controller, appSettingsService } = buildController({ user: { id: 'admin-A' } });

        const response = await controller.impersonate('target-B', {}, REQ);

        expect(appSettingsService.getValueWithDefault).toHaveBeenCalledWith('JWT_IMPERSONATION_EXPIRES_IN', '30m');
        const claims = decodeJwtPayload(response.token) as { exp: number; iat: number };
        expect(claims.exp - claims.iat).toBe(1800);
        expect(response.expiresInSeconds).toBeGreaterThan(1700);
        expect(new Date(response.expiresAt!).getTime()).toBe(claims.exp * 1000);
    });

    it('honours expiresInSeconds and clamps it to [10, 1800]', async () => {
        const { controller } = buildController({ user: { id: 'admin-A' } });

        const short = decodeJwtPayload((await controller.impersonate('target-B', { expiresInSeconds: 60 }, REQ)).token) as { exp: number; iat: number };
        expect(short.exp - short.iat).toBe(60);

        const floor = decodeJwtPayload((await controller.impersonate('target-B', { expiresInSeconds: 1 }, REQ)).token) as { exp: number; iat: number };
        expect(floor.exp - floor.iat).toBe(10);

        const ceil = decodeJwtPayload((await controller.impersonate('target-B', { expiresInSeconds: 90_000 }, REQ)).token) as { exp: number; iat: number };
        expect(ceil.exp - ceil.iat).toBe(1800);
    });

    it('rejects a non-global-admin caller (doctor) with 403 + CALLER_NOT_SUPER_ADMIN', async () => {
        const { controller, eventEmitter } = buildController({
            user: { id: 'admin-A', tenantId: 'tenant-A' },
            fixture: { actorRoles: [DOCTOR] },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(ForbiddenException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.CallerNotSuperAdmin })]);
    });

    it('rejects a TENANT_ADMIN caller with 403 (global-admin only, stricter than the legacy route)', async () => {
        const { controller } = buildController({
            user: { id: 'admin-A', tenantId: 'tenant-A' },
            fixture: { actorRoles: [TENANT_ADMIN] },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(ForbiddenException);
    });

    it('rejects the retired SUPER_ADMIN role literal — no longer elevated (TASK-417)', async () => {
        const { controller, eventEmitter } = buildController({
            user: { id: 'admin-A', tenantId: 'tenant-A' },
            fixture: { actorRoles: [RETIRED_SUPER_ADMIN] },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(ForbiddenException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.CallerNotSuperAdmin })]);
    });

    it('rejects self-impersonation with 400 + SELF_IMPERSONATION', async () => {
        const { controller, eventEmitter } = buildController({ user: { id: 'admin-A' } });

        await expect(controller.impersonate('admin-A', {}, REQ)).rejects.toThrow(BadRequestException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.SelfImpersonation })]);
    });

    it('rejects a global-admin target with 400 + TARGET_IS_SUPER_ADMIN', async () => {
        const { controller, eventEmitter } = buildController({
            user: { id: 'admin-A' },
            fixture: { targetRoles: [{ name: 'GLOBAL_ADMIN' }] },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(BadRequestException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.TargetIsSuperAdmin })]);
    });

    it('rejects a disabled target with 400 + TARGET_DISABLED', async () => {
        const { controller, eventEmitter } = buildController({
            user: { id: 'admin-A' },
            fixture: { target: { id: 'target-B', username: 'doctor.bob', resourceStatus: 'DISABLED' } },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(BadRequestException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.TargetDisabled })]);
    });

    it('rejects an unknown target with 404', async () => {
        const { controller } = buildController({ user: { id: 'admin-A' }, fixture: { target: null } });

        await expect(controller.impersonate('ghost', {}, REQ)).rejects.toThrow(NotFoundException);
    });

    it('rejects nested impersonation with 403 + NESTED_IMPERSONATION (before any lookup)', async () => {
        const { controller, eventEmitter, userRepository } = buildController({
            user: { id: 'admin-A', impersonatedBy: 'root-admin' },
        });

        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(ForbiddenException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.NestedImpersonation })]);
        expect(userRepository.findFirst).not.toHaveBeenCalled();
    });

    it('throws 401 when no user is in context', async () => {
        const { controller } = buildController({ user: null });
        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(UnauthorizedException);
    });

    it('honours a valid targetTenantId and rejects an unassigned one', async () => {
        const { controller } = buildController({
            user: { id: 'admin-A' },
            fixture: { targetTenants: ['tenant-A', 'tenant-B'] },
        });

        const ok = await controller.impersonate('target-B', { targetTenantId: 'tenant-A' }, REQ);
        expect(ok.user.tenantId).toBe('tenant-A');

        await expect(controller.impersonate('target-B', { targetTenantId: 'tenant-Z' }, REQ)).rejects.toThrow(BadRequestException);
    });

    it('rejects when the target has no tenant assignment', async () => {
        const { controller } = buildController({ user: { id: 'admin-A' }, fixture: { targetTenants: [] } });
        await expect(controller.impersonate('target-B', {}, REQ)).rejects.toThrow(BadRequestException);
    });
});

describe('AdminImpersonationController — TASK-401 audit emissions', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits the START bracket, the Started signal, and the forced audit row with reason/expiry/tenant', async () => {
        const { controller, eventEmitter, authService } = buildController({ user: { id: 'admin-A', tenantId: null } });

        const response = await controller.impersonate('target-B', { reason: '  support ticket #42  ' }, REQ);

        expect(authService.trackAuthentication).toHaveBeenCalledWith('admin-A', expect.objectContaining({ endpoint: '/admin/users/target-B/impersonate' }));

        const bracket = eventEmitter.emit.mock.calls.find(([name]) => name === EventTypes.UserAuthenticated);
        expect(bracket?.[1]).toEqual(
            expect.objectContaining({
                userId: 'admin-A',
                impersonatedUserId: 'target-B',
                phase: 'START',
                reason: 'support ticket #42',
                expiresAt: response.expiresAt,
                impersonationTenantId: 'tenant-B',
            }),
        );

        const started = eventEmitter.emit.mock.calls.find(([name]) => name === ImpersonationEvents.Started);
        expect(started?.[1]).toEqual(
            expect.objectContaining({ adminId: 'admin-A', targetUserId: 'target-B', tenantId: 'tenant-B', success: true, reason: 'support ticket #42' }),
        );

        // Forced audit row, attributed to the RESOLVED tenant
        // because the global admin's CLS tenant is null.
        const forced = eventEmitter.emit.mock.calls.find(([name]) => name === SysEventType.ResourceViewed);
        expect(forced?.[1]).toEqual(
            expect.objectContaining({
                responsibleEntityId: 'admin-A',
                resourceId: 'target-B',
                tenantId: 'tenant-B',
                forceAuditLog: true,
                data: expect.objectContaining({
                    action: USER_IMPERSONATION_STARTED,
                    impersonatorUserId: 'admin-A',
                    targetUserId: 'target-B',
                    reason: 'support ticket #42',
                    expiresAt: response.expiresAt,
                }),
            }),
        );
    });

    it('prefers the CLS tenant for the forced row when the global admin is tenant-scoped', async () => {
        const { controller, eventEmitter } = buildController({ user: { id: 'admin-A', tenantId: 'tenant-CLS' } });

        await controller.impersonate('target-B', {}, REQ);

        const forced = eventEmitter.emit.mock.calls.find(([name]) => name === SysEventType.ResourceViewed);
        expect((forced?.[1] as { tenantId: string }).tenantId).toBe('tenant-CLS');
    });

    // A global-admin's JWT carries `tenantId: ''` (empty string,
    // never `null`; see `resolve-active-tenant.ts`). The prior `?? resolvedTenantId`
    // only falls back on null/undefined, so an unscoped global admin produced a
    // forced audit row with `tenantId: ''`, which `AuditLogProcessor`'s
    // fail-closed guard rejects (`job.data.tenantId is required`). The `null`
    // case above never reproduced this because the test harness's sentinel for
    // "no tenant" didn't match the real empty-string CLS/JWT shape.
    it('falls back to the resolved tenant when CLS tenantId is empty string (real global-admin JWT shape)', async () => {
        const { controller, eventEmitter } = buildController({ user: { id: 'admin-A', tenantId: '' } });

        await controller.impersonate('target-B', {}, REQ);

        const forced = eventEmitter.emit.mock.calls.find(([name]) => name === SysEventType.ResourceViewed);
        expect((forced?.[1] as { tenantId: string }).tenantId).toBe('tenant-B');
    });

    it('omits reason from the audit payloads when not provided (never undefined-noise)', async () => {
        const { controller, eventEmitter } = buildController({ user: { id: 'admin-A' } });

        await controller.impersonate('target-B', {}, REQ);

        const forced = eventEmitter.emit.mock.calls.find(([name]) => name === SysEventType.ResourceViewed);
        expect((forced?.[1] as { data: { reason: string | null } }).data.reason).toBeNull();
        const bracket = eventEmitter.emit.mock.calls.find(([name]) => name === EventTypes.UserAuthenticated);
        expect((bracket?.[1] as { reason?: string }).reason).toBeUndefined();
    });
});
