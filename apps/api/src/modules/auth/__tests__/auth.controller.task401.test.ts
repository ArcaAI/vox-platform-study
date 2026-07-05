/**
 * AuthController — TASK-401 backports on the legacy impersonation routes.
 *
 *   - `/auth/impersonate` now rejects NESTED impersonation (an impersonated
 *     session can never start another) and SELF-impersonation, each with a
 *     dedicated audited denial code.
 *   - `/auth/revoke-impersonation` now emits the forced
 *     `USER_IMPERSONATION_ENDED` audit row (TASK-396 forceAuditLog pattern),
 *     symmetric with the START row from the TASK-401 admin endpoint.
 *
 * Harness mirrors auth.controller.task295.test.ts (pure unit, no container).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SysEventType } from '@arcaai/domains';
import { AuthController } from '../auth.controller';
import { ImpersonationEvents, ImpersonationDeniedReason } from '../impersonation-events';

const REQ = { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } } as never;

interface ClsUserStub {
    id: string;
    tenantId?: string | null;
    impersonatedBy?: string;
    jti?: string;
    exp?: number;
}

function buildController(user: ClsUserStub | null) {
    const cls = {
        get: vi.fn((key: string) => {
            if (key === 'user') return user;
            if (key === 'tenantId') return user?.tenantId ?? null;
            if (key === 'correlationId') return 'corr-legacy';
            return null;
        }),
        set: vi.fn(),
    };
    const userRepository = { findFirst: vi.fn(async () => ({ id: 'target-B', username: 'doctor.bob', UserProfile: { email: 'bob@x' } })), update: vi.fn() };
    const appSettingsService = { getValueWithDefault: vi.fn((_k: string, fallback: string) => fallback) };
    const authService = { trackAuthentication: vi.fn().mockResolvedValue(undefined) };
    const userRoleAssignmentService = {
        findActiveRolesForUser: vi.fn(async (userId: string) =>
            (userId === 'admin-A' ? ['GLOBAL_ADMIN'] : ['DOCTOR']).map((name) => ({ id: `role-${name}`, name, permissions: [] })),
        ),
        findActiveTenantIdsForUser: vi.fn(async () => ['tenant-B']),
        findActiveAssignmentForUserInTenant: vi.fn(async () => null),
    };
    const jwtRevocationService = { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) };
    const secretsService = { getSecretSync: vi.fn(() => 'test-secret-key'), getSecretOptional: vi.fn(async () => undefined) };
    const refreshTokenService = { issue: vi.fn(), consume: vi.fn(), revokeFamily: vi.fn() };
    const userDepartmentService = { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'ud-default' })) };
    const eventEmitter = { emit: vi.fn() };

    const controller = new AuthController(
        {} as never,
        authService as never,
        appSettingsService as never,
        userRoleAssignmentService as never,
        userRepository as never,
        {} as never,
        {} as never,
        {} as never,
        cls as never,
        { issueTicket: vi.fn(), consumeTicket: vi.fn() } as never,
        jwtRevocationService as never,
        secretsService as never,
        refreshTokenService as never,
        userDepartmentService as never,
        eventEmitter as never,
        {} as never,
    );

    return { controller, eventEmitter, jwtRevocationService, userRepository };
}

function deniedEvents(eventEmitter: { emit: ReturnType<typeof vi.fn> }) {
    return eventEmitter.emit.mock.calls.filter(([name]) => name === ImpersonationEvents.Denied).map(([, payload]) => payload);
}

describe('AuthController — TASK-401 legacy /auth/impersonate backports', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects a NESTED impersonation attempt with 403 + NESTED_IMPERSONATION before any lookup', async () => {
        const { controller, eventEmitter, userRepository } = buildController({ id: 'admin-A', tenantId: 'tenant-A', impersonatedBy: 'root-admin' });

        await expect(controller.impersonate({ targetUserId: 'target-B' } as never, REQ)).rejects.toThrow(ForbiddenException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.NestedImpersonation })]);
        expect(userRepository.findFirst).not.toHaveBeenCalled();
    });

    it('rejects SELF-impersonation with 400 + SELF_IMPERSONATION', async () => {
        const { controller, eventEmitter } = buildController({ id: 'admin-A', tenantId: 'tenant-A' });

        await expect(controller.impersonate({ targetUserId: 'admin-A' } as never, REQ)).rejects.toThrow(BadRequestException);
        expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.SelfImpersonation })]);
    });

    it('still allows a GLOBAL_ADMIN to impersonate a regular target (no regression)', async () => {
        const { controller } = buildController({ id: 'admin-A', tenantId: 'tenant-A' });

        const response = await controller.impersonate({ targetUserId: 'target-B' } as never, REQ);
        expect(response.user.id).toBe('target-B');
        expect(response.impersonatedBy).toBe('admin-A');
    });
});

describe('AuthController — TASK-401 revoke-impersonation END audit row', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits the forced USER_IMPERSONATION_ENDED row attributed to the impersonation tenant', async () => {
        const { controller, eventEmitter, jwtRevocationService } = buildController({
            id: 'target-B',
            tenantId: 'tenant-B',
            impersonatedBy: 'admin-A',
            jti: 'impersonate-abc',
            exp: 1234567890,
        });

        const response = await controller.revokeImpersonation(REQ);

        expect(response.success).toBe(true);
        expect(jwtRevocationService.revoke).toHaveBeenCalledWith('impersonate-abc', 1234567890);

        const forced = eventEmitter.emit.mock.calls.find(([name]) => name === SysEventType.ResourceViewed);
        expect(forced?.[1]).toEqual(
            expect.objectContaining({
                responsibleEntityId: 'admin-A',
                resourceId: 'target-B',
                tenantId: 'tenant-B',
                forceAuditLog: true,
                data: expect.objectContaining({
                    action: 'USER_IMPERSONATION_ENDED',
                    impersonatorUserId: 'admin-A',
                    targetUserId: 'target-B',
                }),
            }),
        );

        // The pre-existing Ended signal still fires (no regression).
        expect(eventEmitter.emit.mock.calls.some(([name]) => name === ImpersonationEvents.Ended)).toBe(true);
    });
});
