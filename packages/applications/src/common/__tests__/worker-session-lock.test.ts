import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { TenantLockedError } from '../../services/tenant-checkpoint/lock/tenant-locked.error';
import { TENANT_LOCK_POSTPONE_MS, assertTenantUnlocked, postponeIfTenantLocked } from '../worker-session-lock';

const lockOf = (state: { locked: boolean; restoreId?: string; categories?: ('CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL')[] }) => ({ state: vi.fn().mockResolvedValue(state), publishChange: vi.fn() });

describe('assertTenantUnlocked', () => {
  it('throws TenantLockedError for a locked tenant', async () => {
    await expect(assertTenantUnlocked(lockOf({ locked: true, restoreId: 'R' }), 'T', ['CLINICAL'])).rejects.toMatchObject({
      name: 'TenantLockedError',
      tenantId: 'T',
      restoreId: 'R',
    });
  });
  it.each([
    [['CONFIG_CONTENT'], ['CONFIG_CONTENT'], true],
    [['CONFIG_CONTENT'], ['USERS_ACCESS'], false],
    [['CONFIG_CONTENT'], ['CLINICAL'], false],
    [['USERS_ACCESS'], ['USERS_ACCESS'], true],
    [['USERS_ACCESS'], ['CONFIG_CONTENT'], false],
    [['CONFIG_CONTENT', 'CLINICAL'], ['CLINICAL'], true],
    [['CONFIG_CONTENT', 'CLINICAL'], ['USERS_ACCESS'], false],
    [undefined, ['USERS_ACCESS'], true],
  ] as const)('lock categories %j vs job conflicting %j → blocks=%s', async (categories, conflictsWith, blocks) => {
    const assertion = expect(assertTenantUnlocked(lockOf({ locked: true, categories: categories as never }), 'T', conflictsWith));
    if (blocks) await assertion.rejects.toMatchObject({ name: 'TenantLockedError' });
    else await assertion.resolves.toBeUndefined();
  });
  it('passes for an unlocked tenant, a missing service or a missing tenant', async () => {
    await expect(assertTenantUnlocked(lockOf({ locked: false }), 'T', ['CLINICAL'])).resolves.toBeUndefined();
    await expect(assertTenantUnlocked(undefined, 'T', ['CLINICAL'])).resolves.toBeUndefined();
    const lock = lockOf({ locked: true });
    await expect(assertTenantUnlocked(lock, undefined, ['CLINICAL'])).resolves.toBeUndefined();
    expect(lock.state).not.toHaveBeenCalled();
  });
  it('propagates an unreadable lock state', async () => {
    const lock = { state: vi.fn().mockRejectedValue(new Error('db down')), publishChange: vi.fn() };
    await expect(assertTenantUnlocked(lock, 'T', ['CLINICAL'])).rejects.toThrow('db down');
  });
});

describe('postponeIfTenantLocked', () => {
  it('moves the job to delayed and throws DelayedError when locked', async () => {
    const job = { moveToDelayed: vi.fn().mockResolvedValue(undefined) };
    const before = Date.now();
    await expect(postponeIfTenantLocked(lockOf({ locked: true }), job, 'tok', 'T', ['CLINICAL'])).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [at, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe('tok');
    expect(at).toBeGreaterThanOrEqual(before + TENANT_LOCK_POSTPONE_MS);
  });
  it('does nothing when unlocked', async () => {
    const job = { moveToDelayed: vi.fn() };
    await expect(postponeIfTenantLocked(lockOf({ locked: false }), job, 'tok', 'T', ['CLINICAL'])).resolves.toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('lets a non-lock error through unchanged', async () => {
    const job = { moveToDelayed: vi.fn() };
    const lock = { state: vi.fn().mockRejectedValue(new Error('db down')), publishChange: vi.fn() };
    await expect(postponeIfTenantLocked(lock, job, 'tok', 'T', ['CLINICAL'])).rejects.toThrow('db down');
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
