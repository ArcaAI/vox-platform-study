/**
 * Service accounts are API-only principals.
 *
 * A service account authenticates with an API key; it must never obtain an
 * interactive session. Three interactive doors are closed here:
 *
 *   1. `POST /auth/login`                       — 401 even with valid credentials
 *   2. `POST /auth/impersonate` (legacy)        — 400 + TARGET_IS_SERVICE_ACCOUNT
 *   3. `POST /admin/users/:id/impersonate`      — 400 + TARGET_IS_SERVICE_ACCOUNT
 *
 * Harness mirrors auth.controller.task401.test.ts (pure unit, no container).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthController } from '../auth.controller';
import { AdminImpersonationController } from '../admin-impersonation.controller';
import { ImpersonationEvents, ImpersonationDeniedReason } from '../impersonation-events';

const REQ = { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } } as never;

function deniedEvents(eventEmitter: { emit: ReturnType<typeof vi.fn> }) {
  return eventEmitter.emit.mock.calls.filter(([name]) => name === ImpersonationEvents.Denied).map(([, payload]) => payload);
}

// ---------------------------------------------------------------------------
// AuthController harness (login + legacy impersonate)
// ---------------------------------------------------------------------------

interface AuthFixture {
  /** Users resolvable by the repository (login finds by username, impersonate by id). */
  users: Array<Record<string, unknown>>;
  /** The CLS caller for the impersonate route (null for login). */
  clsUser?: { id: string; tenantId?: string | null } | null;
}

function buildAuthController(fixture: AuthFixture) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return fixture.clsUser ?? null;
      if (key === 'tenantId') return fixture.clsUser?.tenantId ?? null;
      return null;
    }),
    set: vi.fn(),
  };
  const userRepository = {
    findFirst: vi.fn(async (props: { filters?: { id?: string; username?: string } }) => {
      const { id, username } = props?.filters ?? {};
      return fixture.users.find((u) => (id ? u.id === id : u.username === username)) ?? null;
    }),
    update: vi.fn(),
  };
  const tenantRepository = {
    findFirst: vi.fn(async () => ({ id: 'tenant-001', key: 'acme-hospital', name: 'Acme', resourceStatus: 'ENABLED' })),
  };
  const userRoleAssignmentService = {
    findActiveRolesForUser: vi.fn(async (userId: string) =>
      (userId === 'admin-A' ? ['GLOBAL_ADMIN'] : ['DOCTOR']).map((name) => ({ id: `role-${name}`, name, permissions: [] })),
    ),
    findActiveTenantIdsForUser: vi.fn(async () => ['tenant-001']),
    findActiveAssignmentForUserInTenant: vi.fn(async () => ({ id: 'ura-1' })),
  };
  const eventEmitter = { emit: vi.fn() };

  const controller = new AuthController(
    {} as never,
    { trackAuthentication: vi.fn().mockResolvedValue(undefined), revokeToken: vi.fn() } as never,
    { getValueWithDefault: vi.fn((_k: string, fallback: string) => fallback) } as never,
    userRoleAssignmentService as never,
    userRepository as never,
    {} as never,
    {} as never,
    tenantRepository as never,
    cls as never,
    { issueTicket: vi.fn(), consumeTicket: vi.fn() } as never,
    { revoke: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false) } as never,
    { getSecretSync: vi.fn(() => 'test-secret-key'), getSecretOptional: vi.fn(async () => undefined) } as never,
    { issue: vi.fn(async () => ({ rawToken: 'opaque', family: 'fam', expiresAt: 0 })), consume: vi.fn(), revokeFamily: vi.fn() } as never,
    { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'ud-default' })) } as never,
    eventEmitter as never,
    {} as never,
    { lookup: vi.fn().mockResolvedValue(null) } as never,
  );

  return { controller, eventEmitter, userRepository };
}

// ---------------------------------------------------------------------------
// AdminImpersonationController harness (mirrors task401)
// ---------------------------------------------------------------------------

function buildAdminController(target: Record<string, unknown>) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'admin-A', tenantId: null };
      if (key === 'correlationId') return 'corr-430';
      return null;
    }),
    set: vi.fn(),
  };
  const eventEmitter = { emit: vi.fn() };
  const userRoleAssignmentService = {
    findActiveRolesForUser: vi.fn(async (userId: string) =>
      (userId === 'admin-A' ? ['GLOBAL_ADMIN'] : ['DOCTOR']).map((name) => ({ id: `role-${name}`, name, permissions: [] })),
    ),
    findActiveTenantIdsForUser: vi.fn(async () => ['tenant-B']),
    findActiveAssignmentForUserInTenant: vi.fn(async () => null),
  };

  const controller = new AdminImpersonationController(
    { trackAuthentication: vi.fn().mockResolvedValue(undefined) } as never,
    { getValueWithDefault: vi.fn((_k: string, fallback: string) => fallback) } as never,
    userRoleAssignmentService as never,
    { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'dept-primary' })) } as never,
    { findFirst: vi.fn(async () => target) } as never,
    cls as never,
    { getSecretSync: vi.fn(() => 'test-secret-key'), getSecretOptional: vi.fn(async () => undefined) } as never,
    eventEmitter as never,
  );

  return { controller, eventEmitter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('service accounts are API-only', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /auth/login', () => {
    it('rejects a service account with 401 even when the credentials are valid', async () => {
      const password = await bcrypt.hash('valid-pass', 10);
      const { controller, userRepository } = buildAuthController({
        users: [
          {
            id: 'svc-001',
            username: 'svc.integration',
            password,
            isServiceAccount: true,
            resourceStatus: 'ENABLED',
            UserProfile: { email: 'svc@x' },
          },
        ],
      });

      await expect(controller.login({ username: 'svc.integration', password: 'valid-pass', tenantKey: 'acme-hospital' }, REQ)).rejects.toThrow(
        UnauthorizedException,
      );
      // The account row itself is never mutated (no lastLoginAt stamp).
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('still allows a regular (human) user to log in', async () => {
      const password = await bcrypt.hash('valid-pass', 10);
      const { controller } = buildAuthController({
        users: [
          {
            id: 'user-001',
            username: 'dr_smith',
            password,
            isServiceAccount: false,
            resourceStatus: 'ENABLED',
            UserProfile: { email: 'smith@x' },
          },
        ],
      });

      const result = await controller.login({ username: 'dr_smith', password: 'valid-pass', tenantKey: 'acme-hospital' }, REQ);
      expect(result.user.id).toBe('user-001');
      expect(result).toHaveProperty('token');
    });
  });

  describe('POST /auth/impersonate (legacy)', () => {
    it('rejects a service-account target with 400 + TARGET_IS_SERVICE_ACCOUNT', async () => {
      const { controller, eventEmitter } = buildAuthController({
        clsUser: { id: 'admin-A', tenantId: 'tenant-001' },
        users: [
          {
            id: 'svc-001',
            username: 'svc.integration',
            isServiceAccount: true,
            resourceStatus: 'ENABLED',
            UserProfile: { email: 'svc@x' },
          },
        ],
      });

      await expect(controller.impersonate({ targetUserId: 'svc-001' } as never, REQ)).rejects.toThrow(BadRequestException);
      expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.TargetIsServiceAccount })]);
    });
  });

  describe('POST /admin/users/:id/impersonate', () => {
    it('rejects a service-account target with 400 + TARGET_IS_SERVICE_ACCOUNT', async () => {
      const { controller, eventEmitter } = buildAdminController({
        id: 'svc-001',
        username: 'svc.integration',
        isServiceAccount: true,
        resourceStatus: 'ENABLED',
        UserProfile: { email: 'svc@x' },
      });

      await expect(controller.impersonate('svc-001', {}, REQ)).rejects.toThrow(BadRequestException);
      expect(deniedEvents(eventEmitter)).toEqual([expect.objectContaining({ reason: ImpersonationDeniedReason.TargetIsServiceAccount })]);
    });
  });
});
