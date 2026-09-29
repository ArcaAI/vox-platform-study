/**
 * Usernames and emails are case-insensitive. `User.username` is only
 * case-sensitively unique in the database, so without an application-level
 * check `Bob@x.com` and `bob@x.com` can both be created — and then login,
 * which matches case-insensitively, cannot tell them apart.
 *
 *   - create: a username that matches an existing one in ANY case is a 409,
 *     raised before any hashing or write.
 *   - update: renaming to a name another user holds (in any case) is a 409;
 *     changing only the case of your own username is allowed.
 *   - the profile email is stored trimmed + lowercased.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { UserService } from '../user.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockUserRepository = { create: vi.fn(), findById: vi.fn(), update: vi.fn(), findByUsername: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };
const mockDatabaseService = { baseClient: { $transaction: vi.fn() } };
const mockUserProfileService = { upsertByUserId: vi.fn() };
const mockCryptoService = { hash: vi.fn(async (pw: string) => `$2b$10$hashed::${pw}`), verify: vi.fn() };
const mockAppSettings = { getValueWithDefault: vi.fn(<T>(_key: string, defaultValue: T): T => defaultValue) };

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

describe('UserService — case-insensitive username / email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No tenant context: the plain, membership-less create path.
    mockClsService.get.mockReturnValue(null);
    mockUserRepository.findByUsername.mockResolvedValue(null);
    mockUserRepository.create.mockImplementation(async (entity: any) => entity);
  });

  describe('create', () => {
    it('refuses a username that differs from an existing one only by case (409) before any hashing or write', async () => {
      mockUserRepository.findByUsername.mockResolvedValue({ id: 'existing-user', username: 'Bob@Example.com' });

      await expect(buildService().create({ username: 'bob@example.com', password: 'Password123!' } as any)).rejects.toBeInstanceOf(ConflictException);

      expect(mockUserRepository.findByUsername).toHaveBeenCalledWith('bob@example.com');
      expect(mockCryptoService.hash).not.toHaveBeenCalled();
      expect(mockUserRepository.create).not.toHaveBeenCalled();
    });

    it('creates the user when no case-variant exists', async () => {
      const user = await buildService().create({ username: 'bob@example.com', password: 'Password123!' } as any);

      expect(user.username).toBe('bob@example.com');
      expect(mockUserRepository.create).toHaveBeenCalledTimes(1);
    });

    it('stores the profile email trimmed and lowercased', async () => {
      const user = await buildService().create({ username: 'bob', email: '  Bob@Example.COM ', password: 'Password123!' } as any);

      expect(mockUserProfileService.upsertByUserId).toHaveBeenCalledWith(user.id, { email: 'bob@example.com' });
    });
  });

  describe('update', () => {
    const current = () => ({
      id: 'user-1',
      username: 'Bob',
      toObject: () => ({}),
      hasChanges: true,
      changes: {},
    });

    beforeEach(() => {
      mockUserRepository.findById.mockResolvedValue(current());
      mockUserRepository.update.mockImplementation(async (_id: string, entity: any) => entity);
    });

    it('refuses renaming to a username another user holds in any case (409)', async () => {
      mockUserRepository.findByUsername.mockResolvedValue({ id: 'someone-else', username: 'Alice' });

      await expect(buildService().update('user-1', { username: 'alice' } as any)).rejects.toBeInstanceOf(ConflictException);

      expect(mockUserRepository.update).not.toHaveBeenCalled();
    });

    it("allows changing only the case of the user's own username", async () => {
      mockUserRepository.findByUsername.mockResolvedValue({ id: 'user-1', username: 'Bob' });

      await expect(buildService().update('user-1', { username: 'BOB' } as any)).resolves.toBeDefined();
    });

    it('does not look the username up when the update does not touch it', async () => {
      await buildService().update('user-1', {} as any);

      expect(mockUserRepository.findByUsername).not.toHaveBeenCalled();
    });
  });
});
