/**
 * UserRepository.findByUsername — usernames (and the emails that default into
 * them) are case-insensitive for lookup, but `User.username` is only
 * case-sensitively unique. So: prefer an EXACT-case match (keeps any legacy
 * case-variant twins independently reachable), then fall back to a
 * case-insensitive one.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { UserRepository } from '../generated/core/UserRepository';
import { ResourceStatusType } from '../../enums';

function row(username: string) {
  return {
    id: 'u-1',
    username,
    password: 'hash',
    isServiceAccount: false,
    resourceStatus: ResourceStatusType.ENABLED,
    version: 1,
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00Z'),
    secret1: '',
    secret2: '',
    secret1Expiry: new Date('2026-01-01T00:00:00Z'),
    secret2Expiry: new Date('2026-01-01T00:00:00Z'),
  };
}

function makeRepo() {
  const delegate = { findFirst: vi.fn() };
  const uow = { getDatabaseService: () => ({ user: delegate }) };
  return { repo: new UserRepository(uow as never), delegate };
}

describe('UserRepository.findByUsername', () => {
  it('returns an exact-case match without a second query', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValueOnce(row('Admin@Acme.test'));

    const user = await repo.findByUsername('Admin@Acme.test');

    expect(user?.username).toBe('Admin@Acme.test');
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({ username: 'Admin@Acme.test' });
  });

  it('falls back to a case-insensitive match when no exact-case row exists', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Admin@Acme.test'));

    const user = await repo.findByUsername('admin@acme.test');

    expect(user?.username).toBe('Admin@Acme.test');
    expect(delegate.findFirst).toHaveBeenCalledTimes(2);
    expect(delegate.findFirst.mock.calls[1][0].where).toEqual({ username: { equals: 'admin@acme.test', mode: 'insensitive' } });
  });

  it('returns null when neither lookup matches', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValue(null);

    await expect(repo.findByUsername('ghost')).resolves.toBeNull();
  });

  it('applies the resourceStatus filter to both lookups when asked', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValue(null);

    await repo.findByUsername('Bob', { resourceStatus: ResourceStatusType.ENABLED });

    expect(delegate.findFirst.mock.calls[0][0].where).toEqual({ username: 'Bob', resourceStatus: ResourceStatusType.ENABLED });
    expect(delegate.findFirst.mock.calls[1][0].where).toEqual({
      username: { equals: 'Bob', mode: 'insensitive' },
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('does not swallow a real database error as "not found"', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockRejectedValue(new Error('connection lost'));

    await expect(repo.findByUsername('Bob')).rejects.toThrow('connection lost');
  });
});
