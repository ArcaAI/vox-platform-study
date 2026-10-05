import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { TenantLockService } from '@arcaai/applications';
import { TenantLockGuard } from '../tenant-lock.guard';
import { InternalTenantLockGuard } from '../internal-tenant-lock.guard';

/**
 * Internal (`/internal/*`) routes are `@Public()`: the request CLS is active but carries no tenant
 * when the lock guards run. The lock read hits a tenant-scoped model, so it must run under the
 * tenant being checked — otherwise the tenant-scope extension throws and every cold-cache internal
 * call answers 503 `TENANT_LOCK_UNAVAILABLE`.
 */

const cls = ClsServiceManager.getClsService();
const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as unknown as Reflector;

/** Behaves like `findActiveByTenant` behind the tenant-scope extension. */
const scopedRepository = (impl: (tenantId: string) => Promise<unknown> = async () => null) => {
  const seen: Array<string | undefined> = [];
  const findActiveByTenant = vi.fn(async (tenantId: string) => {
    const ctxTenant = cls.isActive() ? (cls.get('tenantId') as string | undefined) : undefined;
    seen.push(ctxTenant);
    if (cls.isActive() && !ctxTenant) {
      throw new Error('TenantScope: tenant context required for model TenantCheckpointRestore operation findFirst');
    }
    return impl(tenantId);
  });
  return { repo: { findActiveByTenant }, seen };
};

const lockService = (repo: unknown) => new TenantLockService(repo as never, undefined, undefined, undefined, cls as never);

const httpContext = (req: Record<string, unknown>, setHeader = vi.fn()) =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }),
  }) as unknown as ExecutionContext;

/** Runs inside a request-shaped CLS store with no tenant, as the CLS middleware leaves it. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => cls.runWith({} as never, fn);

const T = '50000000-0000-0000-0000-000000000000';
const internalGet = { method: 'GET', originalUrl: '/api/v1/internal/agents/resolve', headers: { 'x-tenant-id': T } };

describe('TenantLockGuard — cold cache on an internal path (TASK-1041)', () => {
  it('reads the lock state under the X-Tenant-Id tenant and lets an unlocked tenant through', async () => {
    const { repo, seen } = scopedRepository();
    const guard = new TenantLockGuard(reflector, cls as never, lockService(repo));
    await expect(inRequest(() => guard.canActivate(httpContext(internalGet)))).resolves.toBe(true);
    expect(seen).toEqual([T]);
  });

  it('does not leak the lock-read tenant into the request context', async () => {
    const { repo } = scopedRepository();
    const guard = new TenantLockGuard(reflector, cls as never, lockService(repo));
    const after = await inRequest(async () => {
      await guard.canActivate(httpContext(internalGet));
      return cls.get('tenantId');
    });
    expect(after).toBeUndefined();
  });

  it('still fails closed (503 + Retry-After) when the lock state is genuinely unreadable', async () => {
    const { repo } = scopedRepository(async () => {
      throw new Error('connection refused');
    });
    const setHeader = vi.fn();
    const guard = new TenantLockGuard(reflector, cls as never, lockService(repo));
    await expect(inRequest(() => guard.canActivate(httpContext(internalGet, setHeader)))).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_LOCK_UNAVAILABLE' },
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('still refuses a CLINICAL restore with 503 TENANT_RESTORE_IN_PROGRESS', async () => {
    const { repo } = scopedRepository(async () => ({ id: 'R1', status: 'RECONCILING', categories: ['CLINICAL'] }));
    const guard = new TenantLockGuard(reflector, cls as never, lockService(repo));
    await expect(inRequest(() => guard.canActivate(httpContext(internalGet)))).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R1' },
    });
  });
});

describe('InternalTenantLockGuard — cold cache, tenant in the body (TASK-1041)', () => {
  const internalPost = { method: 'POST', originalUrl: '/api/v1/internal/harness/x', headers: {}, body: { tenantId: T } };

  it('reads the lock state under the body tenant and lets an unlocked tenant through', async () => {
    const { repo, seen } = scopedRepository();
    const guard = new InternalTenantLockGuard(lockService(repo));
    await expect(inRequest(() => guard.canActivate(httpContext(internalPost)))).resolves.toBe(true);
    expect(seen).toEqual([T]);
  });

  it('still fails closed when the lock state is unreadable', async () => {
    const { repo } = scopedRepository(async () => {
      throw new Error('connection refused');
    });
    const guard = new InternalTenantLockGuard(lockService(repo));
    await expect(inRequest(() => guard.canActivate(httpContext(internalPost)))).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_LOCK_UNAVAILABLE' },
    });
  });
});
