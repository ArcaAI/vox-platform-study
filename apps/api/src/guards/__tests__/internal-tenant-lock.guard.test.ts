import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import type { ExecutionContext } from '@nestjs/common';
import { InternalTenantLockGuard } from '../internal-tenant-lock.guard';

const lockService = (locked: boolean) => ({ state: vi.fn().mockResolvedValue(locked ? { locked: true, restoreId: 'R' } : { locked: false }), publishChange: vi.fn() });
const setHeader = vi.fn();
const ctx = (req: Record<string, unknown>, type = 'http') =>
  ({ getType: () => type, switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }) }) as unknown as ExecutionContext;

describe('InternalTenantLockGuard', () => {
  it('503s (retryable, Retry-After 30) a mutating call whose body names a locked tenant', async () => {
    const lock = lockService(true);
    const guard = new InternalTenantLockGuard(lock);
    setHeader.mockClear();
    await expect(guard.canActivate(ctx({ method: 'POST', body: { tenantId: 'T' }, query: {}, headers: {} }))).rejects.toMatchObject({
      status: 503,
      response: { statusCode: 503, code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(lock.state).toHaveBeenCalledWith('T');
  });

  it.each([
    ['query', { method: 'DELETE', body: {}, query: { tenantId: 'T' }, headers: {} }],
    ['x-internal-tenant-id', { method: 'PATCH', body: {}, query: {}, headers: { 'x-internal-tenant-id': 'T' } }],
    ['x-tenant-id', { method: 'PUT', body: undefined, query: {}, headers: { 'x-tenant-id': 'T' } }],
  ])('resolves the tenant from %s', async (_name, req) => {
    const guard = new InternalTenantLockGuard(lockService(true));
    await expect(guard.canActivate(ctx(req))).rejects.toMatchObject({ status: 503, response: { code: 'TENANT_RESTORE_IN_PROGRESS' } });
  });

  it('lets reads through without querying the lock', async () => {
    const lock = lockService(true);
    const guard = new InternalTenantLockGuard(lock);
    await expect(guard.canActivate(ctx({ method: 'GET', body: {}, query: { tenantId: 'T' }, headers: {} }))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('passes a write that names no tenant, and an unlocked tenant', async () => {
    const lock = lockService(false);
    const guard = new InternalTenantLockGuard(lock);
    await expect(guard.canActivate(ctx({ method: 'POST', body: {}, query: {}, headers: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ method: 'POST', body: { tenantId: 'T' }, query: {}, headers: {} }))).resolves.toBe(true);
  });

  it('ignores non-http contexts', async () => {
    const lock = lockService(true);
    await expect(new InternalTenantLockGuard(lock).canActivate(ctx({}, 'ws'))).resolves.toBe(true);
  });
});
