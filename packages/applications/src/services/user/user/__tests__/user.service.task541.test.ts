/**
 * TASK-541 A4 — disabling a user must kill their LIVE access tokens.
 *
 * Gap under test: `resourceStatus` gates login and refresh (both filter on
 * `ENABLED`), but an access token already in the wild stayed valid until its
 * own `exp` — up to a full `JWT_EXPIRES_IN` window of continued PHI access
 * for an account an admin just disabled, suspended, or deleted.
 *
 * Contract pinned here: every status transition AWAY from `ENABLED`, plus the
 * soft-delete path, stamps a per-user not-before through
 * `IJwtRevocationService.revokeAllForUser`. `JwtStrategy` then refuses any
 * token whose `iat` predates the stamp (see jwt.strategy.test.ts).
 *
 * The revocation stamp is best-effort by design: a Redis failure must never
 * roll back the user mutation itself, since the DB row is the authority that
 * blocks the NEXT login.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { create: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };
const mockDatabaseService = { baseClient: { $transaction: vi.fn() } };
const mockUserProfileService = { upsertByUserId: vi.fn() };
const mockCryptoService = { hash: vi.fn(async (pw: string) => `hashed::${pw}`), verify: vi.fn() };
const mockAppSettings = { getValueWithDefault: vi.fn(<T,>(_k: string, d: T): T => d) };

const mockJwtRevocationService = {
  revoke: vi.fn().mockResolvedValue(undefined),
  isRevoked: vi.fn().mockResolvedValue(false),
  checkRevoked: vi.fn().mockResolvedValue({ revoked: false, degraded: false }),
  revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  getUserNotBefore: vi.fn().mockResolvedValue({ notBefore: null, degraded: false }),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return { ...actual };
});

import { UserService } from '../user.service';

/**
 * Entity double carrying the lifecycle methods `applyChangesToEntity` routes
 * `resourceStatus` through (`enable`/`disable`/`suspend`/`archive`/`delete`) —
 * a plain property bag silently fails there.
 */
function makeUserEntity(id: string, overrides: Record<string, unknown> = {}) {
  const changes: Record<string, unknown> = {};
  const stamp = (status: string) => {
    entity.resourceStatus = status;
    changes.resourceStatus = status;
  };
  const entity: Record<string, unknown> = {
    id,
    username: 'jdoe',
    resourceStatus: 'ENABLED',
    hasChanges: true,
    changes,
    enable: vi.fn(() => stamp('ENABLED')),
    disable: vi.fn(() => stamp('DISABLED')),
    suspend: vi.fn(() => stamp('SUSPENDED')),
    archive: vi.fn(() => stamp('ARCHIVED')),
    delete: vi.fn(() => stamp('DELETED')),
    toObject: vi.fn().mockReturnValue({ id, username: 'jdoe' }),
    ...overrides,
  };
  return entity;
}

function buildService(revocation: unknown = mockJwtRevocationService) {
  return new UserService(
    mockUserRepository as any,
    mockUserRoleAssignmentRepository as any,
    mockUserDepartmentRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockDatabaseService as any,
    mockUserProfileService as any,
    mockCryptoService as any,
    mockAppSettings as any,
    undefined,
    revocation as any,
  );
}

describe('UserService — TASK-541 A4 token revocation on status change', () => {
  let service: UserService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJwtRevocationService.revokeAllForUser.mockResolvedValue(undefined);
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
    service = buildService();
  });

  describe('update()', () => {
    it.each(['DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED'])(
      'revokes every live token when resourceStatus moves to %s',
      async (status) => {
        const entity = makeUserEntity('user-1');
        mockUserRepository.findById.mockResolvedValue(entity);
        mockUserRepository.update.mockResolvedValue(entity);

        await service.update('user-1', { resourceStatus: status } as never);

        expect(mockJwtRevocationService.revokeAllForUser).toHaveBeenCalledWith('user-1');
      },
    );

    it('does NOT revoke when the status transition is back to ENABLED', async () => {
      const entity = makeUserEntity('user-1');
      mockUserRepository.findById.mockResolvedValue(entity);
      mockUserRepository.update.mockResolvedValue(entity);

      await service.update('user-1', { resourceStatus: 'ENABLED' } as never);

      expect(mockJwtRevocationService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('does NOT revoke on an ordinary field update that leaves status alone', async () => {
      const entity = makeUserEntity('user-1');
      mockUserRepository.findById.mockResolvedValue(entity);
      mockUserRepository.update.mockResolvedValue(entity);

      await service.update('user-1', { username: 'renamed' } as never);

      expect(mockJwtRevocationService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('revokes only AFTER the row is persisted — a failed write must not kill live sessions', async () => {
      const entity = makeUserEntity('user-1');
      mockUserRepository.findById.mockResolvedValue(entity);
      mockUserRepository.update.mockRejectedValue(new Error('write failed'));

      await expect(service.update('user-1', { resourceStatus: 'DISABLED' } as never)).rejects.toThrow('write failed');

      expect(mockJwtRevocationService.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('deleteById()', () => {
    it('revokes every live token on soft delete', async () => {
      const entity = makeUserEntity('user-2', { resourceStatus: 'DELETED' });
      mockUserRepository.softDelete.mockResolvedValue(entity);

      await service.deleteById('user-2');

      expect(mockJwtRevocationService.revokeAllForUser).toHaveBeenCalledWith('user-2');
    });
  });

  describe('degradation', () => {
    it('still completes the mutation when the revocation store is unavailable', async () => {
      mockJwtRevocationService.revokeAllForUser.mockRejectedValue(new Error('Redis down'));
      const entity = makeUserEntity('user-3');
      mockUserRepository.findById.mockResolvedValue(entity);
      mockUserRepository.update.mockResolvedValue(entity);

      await expect(service.update('user-3', { resourceStatus: 'DISABLED' } as never)).resolves.toBeDefined();
    });

    it('still completes the mutation when no revocation service is wired at all', async () => {
      const serviceWithout = buildService(undefined);
      const entity = makeUserEntity('user-4');
      mockUserRepository.findById.mockResolvedValue(entity);
      mockUserRepository.update.mockResolvedValue(entity);

      await expect(serviceWithout.update('user-4', { resourceStatus: 'DISABLED' } as never)).resolves.toBeDefined();
    });
  });
});
