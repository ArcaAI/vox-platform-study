/**
 * TenantSttConfigAdminController unit tests (Phase D, item 5).
 *
 * CASL `@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ the cross-tenant e2e spec). These specs cover the
 * controller's OWN logic: tenant vs. super-admin scoping, and the
 * If-Match-over-body version precedence forwarded to the service on BOTH the
 * fallback row and the OCC-guarded credential write.
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
    getCredentials: vi.fn(),
    setCredential: vi.fn(),
    removeCredential: vi.fn(),
    testCredential: vi.fn(),
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

describe('TenantSttConfigAdminController — BYO credentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setCredential prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.setCredential.mockResolvedValue({ provider: 'sarvam', hasKey: true });
    await controller.setCredential('sarvam', { apiKey: 'k', expectedVersion: 0 }, 4, undefined);
    expect(service.setCredential).toHaveBeenCalledWith('t1', 'sarvam', expect.objectContaining({ apiKey: 'k', expectedVersion: 4 }));
  });

  it('setCredential falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.setCredential.mockResolvedValue({ provider: 'azure-speech', hasKey: true });
    await controller.setCredential('azure-speech', { apiKey: 'k', region: 'eastus', expectedVersion: 0 }, undefined, undefined);
    expect(service.setCredential).toHaveBeenCalledWith('t1', 'azure-speech', expect.objectContaining({ region: 'eastus', expectedVersion: 0 }));
  });

  it('removeCredential delegates scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.removeCredential.mockResolvedValue(undefined);
    await controller.removeCredential('openai', undefined);
    expect(service.removeCredential).toHaveBeenCalledWith('t1', 'openai');
  });

  it('rejects a tenant admin managing credentials for another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getCredentials('t2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TenantSttConfigAdminController — test connection (ephemeral, no OCC)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to testCredential scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.testCredential.mockResolvedValue({ ok: true, message: 'Connected — key accepted' });
    const result = await controller.testCredential('openai', { apiKey: 'sk-test' }, undefined);
    expect(result).toEqual({ ok: true, message: 'Connected — key accepted' });
    expect(service.testCredential).toHaveBeenCalledWith('t1', 'openai', { apiKey: 'sk-test' });
  });

  it('rejects a tenant admin testing a credential for another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.testCredential('openai', { apiKey: 'sk-test' }, 't2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super admin test a credential for any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.testCredential.mockResolvedValue({ ok: false, message: 'Rejected — invalid API key' });
    await controller.testCredential('azure-speech', { apiKey: 'bad', region: 'eastus' }, 't9');
    expect(service.testCredential).toHaveBeenCalledWith('t9', 'azure-speech', { apiKey: 'bad', region: 'eastus' });
  });
});
