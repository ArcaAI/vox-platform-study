/**
 * TenantSttConfigAdminController unit tests (Phase D, item 5).
 *
 * CASL `@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ the cross-tenant e2e spec). These specs cover the
 * controller's OWN logic: tenant vs. super-admin scoping, and the
 * If-Match-over-body version precedence forwarded to the service on the
 * fallback row. (The credential facade routes were removed by TASK-862.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantSttConfigAdminController } from '../tenant-stt-config-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    getEffective: vi.fn(),
    getRow: vi.fn(),
    setFallbackPipeline: vi.fn(),
    getFallbackCandidates: vi.fn(),
    resolveProviderOverrides: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new TenantSttConfigAdminController(service as never, cls as never);
  return { controller, service };
}

describe('TenantSttConfigAdminController — scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their CLS tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getEffective.mockResolvedValue({ tenantId: 't1' });
    await controller.getEffective();
    expect(service.getEffective).toHaveBeenCalledWith('t1');
  });

  it('rejects a tenant admin targeting another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow('t2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super admin target any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.getRow.mockResolvedValue({ tenantId: 't9', version: 0 });
    await controller.getRow('t9');
    expect(service.getRow).toHaveBeenCalledWith('t9');
  });

  it('400s when a super admin omits ?tenantId= and has no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.getEffective()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantSttConfigAdminController — fallback row If-Match precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.setFallbackPipeline.mockResolvedValue({ tenantId: 't1', version: 3 });
    await controller.updateRow({ fallbackPipelineId: 'pipe-9', expectedVersion: 1 }, 2, undefined);
    expect(service.setFallbackPipeline).toHaveBeenCalledWith('t1', expect.objectContaining({ fallbackPipelineId: 'pipe-9', expectedVersion: 2 }));
  });

  it('falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.setFallbackPipeline.mockResolvedValue({ tenantId: 't1', version: 1 });
    await controller.updateRow({ fallbackPipelineId: 'pipe-9', expectedVersion: 0 }, undefined, undefined);
    expect(service.setFallbackPipeline).toHaveBeenCalledWith('t1', expect.objectContaining({ expectedVersion: 0 }));
  });
});

describe('TenantSttConfigAdminController — fallback candidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to getFallbackCandidates scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const candidates = [{ id: 'p1', slug: 'sarvam_transcription' }];
    service.getFallbackCandidates.mockResolvedValue(candidates);
    await expect(controller.getFallbackCandidates()).resolves.toBe(candidates);
    expect(service.getFallbackCandidates).toHaveBeenCalledWith('t1');
  });
});
