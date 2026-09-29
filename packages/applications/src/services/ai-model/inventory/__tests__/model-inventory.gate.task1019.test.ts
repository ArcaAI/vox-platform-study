/**
 * TASK-1019 R3 — the bucket inventory is platform administration.
 *
 * Inside a request (CLS active) the caller must be a SUPER_ADMIN with no working
 * tenant — for the run AND for the stored-report read. Outside any request (the
 * settings-gated cron) there is no caller to check and the sweep runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ModelInventoryService } from '../model-inventory.service';

function cls(active: boolean, opts: { roles?: string[]; tenantId?: string | null } = {}) {
  return {
    isActive: vi.fn(() => active),
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'u-1', roles: opts.roles ?? ['SUPER_ADMIN'] };
      if (key === 'tenantId') return opts.tenantId ?? null;
      return null;
    }),
  };
}

function build(context: ReturnType<typeof cls>) {
  const s3 = { listFiles: vi.fn().mockResolvedValue([]), getFile: vi.fn() };
  const repo = { findAll: vi.fn().mockResolvedValue([]), update: vi.fn() };
  const db = { baseClient: {} };
  const svc = new ModelInventoryService(repo as never, s3 as never, db as never, undefined, undefined, context as never);
  return { svc, s3 };
}

describe('ModelInventoryService — R3 platform-admin gate', () => {
  it('a tenant admin gets 403 on run and on the stored-report read; the bucket is never listed', async () => {
    const { svc, s3 } = build(cls(true, { roles: ['TENANT_ADMIN'] }));
    await expect(svc.runInventory()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getLastReport()).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.listFiles).not.toHaveBeenCalled();
  });

  it('a super admin with a working tenant gets 403', async () => {
    const { svc, s3 } = build(cls(true, { tenantId: '50000000-0000-0000-0000-000000000000' }));
    await expect(svc.runInventory()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getLastReport()).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.listFiles).not.toHaveBeenCalled();
  });

  it('a tenant-less super admin runs it', async () => {
    const { svc, s3 } = build(cls(true));
    await expect(svc.runInventory()).resolves.toMatchObject({ rows: [] });
    expect(s3.listFiles).toHaveBeenCalledTimes(1);
  });

  it('the scheduled sweep (no request context) runs without a caller', async () => {
    const { svc, s3 } = build(cls(false, { roles: [] }));
    await expect(svc.runInventory()).resolves.toMatchObject({ rows: [] });
    expect(s3.listFiles).toHaveBeenCalledTimes(1);
  });
});
