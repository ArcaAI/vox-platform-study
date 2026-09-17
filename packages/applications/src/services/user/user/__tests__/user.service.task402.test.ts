/**
 * Admin-created passwords must be bcrypt-hashed.
 *
 * Root cause under test: `UserService.create` forwarded the admin-supplied
 * plaintext `password` straight through `UserFactory.CreateUser` into
 * `userRepository.create`, and `UserService.update` assigned
 * `UpdateUserRequest.password` verbatim — while login verifies with
 * `bcrypt.compare` (so a creation-time password could never log in and the
 * DB held plaintext).
 *
 * Contract pinned here (mirrors the working UserPasswordService paths):
 *   - create(): non-empty password → complexity policy enforced
 *     (400 listing the unmet rules, repository untouched on failure), then
 *     hashed via ICryptoService, and `passwordChangedAt` stamped. BOTH the
 *     plain branch and the atomic create-with-membership branch.
 *   - createExternalUser(): OAuth placeholder `''` is neither validated nor
 *     hashed (no local credential — account stays non-loginable).
 *   - update(): a present `password` goes through the same policy + hash +
 *     stamp; requests without `password` never touch the crypto service.
 *   - Policy knobs resolve through IAppSettingsService (GlobalSettings
 *     overrides honored on this path too).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { UserService } from '../user.service';

const STRONG_PW = 'Password123!';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { create: vi.fn(), findById: vi.fn(), update: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };
const TX = { __txSentinel: true };
const $transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
// `Role` lookup for the SUPER_ADMIN tier guard (TASK-983).
const roleFindUnique = vi.fn(async () => ({ name: 'DOCTOR' }));
const mockDatabaseService = { baseClient: { $transaction, role: { findUnique: roleFindUnique } } };
const mockUserProfileService = { upsertByUserId: vi.fn() };

// Recognizable, reversible fake bcrypt so assertions can prove BOTH "not
// plaintext" and "exactly what the crypto service produced".
const mockCryptoService = {
  hash: vi.fn(async (pw: string) => `$2b$10$hashed::${pw}`),
  verify: vi.fn(),
};

// Policy reader — defaults pass through; individual tests override knobs.
const mockAppSettings = {
  getValueWithDefault: vi.fn(<T>(_key: string, defaultValue: T): T => defaultValue),
};

// Real factory semantics are irrelevant here — echo props so the password the
// SERVICE hands the factory is observable on the entity the repository gets.
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    UserFactory: {
      CreateUser: vi.fn((data) => ({
        ...data,
        id: 'new-user-id',
        createdAt: new Date('2026-07-02T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
        toObject: vi.fn().mockReturnValue({ id: 'new-user-id', username: data.username }),
      })),
    },
  };
});

function buildService() {
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
  );
}

describe('UserService — password hashing on the CRUD paths', () => {
  let service: UserService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppSettings.getValueWithDefault.mockImplementation(<T>(_key: string, d: T): T => d);
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'admin-1', firstName: 'A', lastName: 'D', email: 'a@d.com' };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });
    mockUserRepository.create.mockImplementation(async (entity: any) => entity);
    mockUserRoleAssignmentRepository.create.mockImplementation(async (entity: any) => entity);
    service = buildService();
  });

  // TASK-983 R6: these creates run inside a tenant (CLS `tenantId`), so they
  // now carry the mandatory role + department membership. The password
  // assertions are unchanged — which also proves the membership guard does not
  // mask the policy failures below.
  describe('create()', () => {
    it('hashes the creation-time password before persistence and stamps passwordChangedAt', async () => {
      await service.create({ username: 'alice', password: STRONG_PW, isServiceAccount: false, roleId: 'role-1', departmentId: 'dept-1' } as any);

      expect(mockCryptoService.hash).toHaveBeenCalledWith(STRONG_PW);
      const persisted = mockUserRepository.create.mock.calls[0][0];
      expect(persisted.password).toBe(`$2b$10$hashed::${STRONG_PW}`);
      expect(persisted.password).not.toBe(STRONG_PW);
      expect(persisted.passwordChangedAt).toBeInstanceOf(Date);
    });

    it('rejects a policy-violating password with a 400 listing the unmet rules and never writes', async () => {
      await expect(
        service.create({ username: 'bob', password: 'weak', isServiceAccount: false, roleId: 'role-1', departmentId: 'dept-1' } as any),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: expect.stringContaining('at least 12 characters'),
      });
      expect(mockUserRepository.create).not.toHaveBeenCalled();
      expect(mockCryptoService.hash).not.toHaveBeenCalled();
    });

    it('honors GlobalSetting policy overrides via IAppSettingsService (minLength raised)', async () => {
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, d: T): T => {
        if (key === 'security.password.minLength') return 20 as unknown as T;
        return d;
      });

      // 12+ compliant against defaults, but short of the raised minimum.
      await expect(
        service.create({ username: 'carol', password: STRONG_PW, isServiceAccount: false, roleId: 'role-1', departmentId: 'dept-1' } as any),
      ).rejects.toThrow('at least 20 characters');
      expect(mockUserRepository.create).not.toHaveBeenCalled();
    });

    it('hashes on the atomic create-with-membership branch too', async () => {
      await service.create({ username: 'dave', password: STRONG_PW, roleId: 'role-1', departmentId: 'dept-1' } as any);

      expect($transaction).toHaveBeenCalledTimes(1);
      const persisted = mockUserRepository.create.mock.calls[0][0];
      expect(persisted.password).toBe(`$2b$10$hashed::${STRONG_PW}`);
      expect(persisted.passwordChangedAt).toBeInstanceOf(Date);
    });
  });

  describe('createExternalUser()', () => {
    it('keeps the empty OAuth placeholder unhashed and unvalidated', async () => {
      await service.createExternalUser({ externalId: 'google-123' });

      expect(mockCryptoService.hash).not.toHaveBeenCalled();
      const persisted = mockUserRepository.create.mock.calls[0][0];
      expect(persisted.password).toBe('');
      expect(persisted.passwordChangedAt).toBeUndefined();
    });
  });

  describe('update()', () => {
    // Bare-object entity: applyChangesToEntity assigns fields directly; the
    // static hasChanges/changes stand in for the real change-tracking.
    const buildExistingUser = () => ({
      id: 'user-9',
      username: 'erin',
      password: '$2b$10$hashed::OldPassword1!',
      passwordChangedAt: new Date('2026-01-01T00:00:00Z'),
      hasChanges: true,
      changes: { password: '(redacted)' },
      toObject: vi.fn().mockReturnValue({ id: 'user-9', username: 'erin' }),
    });

    it('policy-validates + hashes a password update and re-stamps passwordChangedAt', async () => {
      const existing = buildExistingUser();
      mockUserRepository.findById.mockResolvedValue(existing);
      mockUserRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      const NEW_PW = 'NewPassword123!';
      await service.update('user-9', { password: NEW_PW });

      expect(mockCryptoService.hash).toHaveBeenCalledWith(NEW_PW);
      expect(existing.password).toBe(`$2b$10$hashed::${NEW_PW}`);
      expect(existing.passwordChangedAt.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
    });

    it('rejects a weak password update before any write', async () => {
      const existing = buildExistingUser();
      mockUserRepository.findById.mockResolvedValue(existing);

      await expect(service.update('user-9', { password: 'weak' })).rejects.toThrow('at least 12 characters');
      expect(mockUserRepository.update).not.toHaveBeenCalled();
      expect(existing.password).toBe('$2b$10$hashed::OldPassword1!');
    });

    it('leaves non-password updates untouched by the crypto service', async () => {
      const existing = buildExistingUser();
      mockUserRepository.findById.mockResolvedValue(existing);
      mockUserRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      await service.update('user-9', { username: 'erin2' });

      expect(mockCryptoService.hash).not.toHaveBeenCalled();
      expect(existing.password).toBe('$2b$10$hashed::OldPassword1!');
    });
  });
});
