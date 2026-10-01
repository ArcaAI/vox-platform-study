import { describe, expect, it, vi } from 'vitest';
import { assertTenantNotLocked } from '../assert-tenant-not-locked';

const lockOf = (state: { locked: boolean; restoreId?: string; categories?: ('CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL')[] }) => ({ state: vi.fn().mockResolvedValue(state), publishChange: vi.fn() });

describe('assertTenantNotLocked', () => {
  it('throws the 423 body when locked', async () => {
    await expect(assertTenantNotLocked(lockOf({ locked: true, restoreId: 'R' }), 'T')).rejects.toMatchObject({
      status: 423,
      response: { statusCode: 423, code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
  });
  it('throws a retryable 503 with the same code for internal callers', async () => {
    await expect(assertTenantNotLocked(lockOf({ locked: true, restoreId: 'R' }), 'T', { internal: true })).rejects.toMatchObject({
      status: 503,
      response: { statusCode: 503, code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
  });
  it('internal callers pass a non-clinical lock; public callers are still 423', async () => {
    const nonClinical = lockOf({ locked: true, restoreId: 'R', categories: ['CONFIG_CONTENT'] });
    await expect(assertTenantNotLocked(nonClinical, 'T', { internal: true })).resolves.toBeUndefined();
    await expect(assertTenantNotLocked(nonClinical, 'T')).rejects.toMatchObject({ status: 423 });
  });
  it('resolves when unlocked', async () => {
    await expect(assertTenantNotLocked(lockOf({ locked: false }), 'T')).resolves.toBeUndefined();
  });
  it('fails closed with 503 TENANT_LOCK_UNAVAILABLE when state is unreadable', async () => {
    const lock = { state: vi.fn().mockRejectedValue(new Error('db down')), publishChange: vi.fn() };
    await expect(assertTenantNotLocked(lock, 'T')).rejects.toMatchObject({ status: 503, response: { code: 'TENANT_LOCK_UNAVAILABLE' } });
  });
});
