/**
 * TenantTtsConfigAdminController unit tests.
 *
 * CASL `@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ e2e). These specs cover the controller's OWN logic:
 * tenant vs. global-admin scoping, and the If-Match-over-body version precedence
 * forwarded to the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantTtsConfigAdminController } from '../tenant-tts-config-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    getEffective: vi.fn(),
    getRow: vi.fn(),
    upsertRow: vi.fn(),
    getPlatformCatalog: vi.fn(),
  };
  // Unified provider-connection plane (`service='tts'`) — backs the
  // credential facade routes.
  const providerConnectionService = {
    list: vi.fn(),
    getRow: vi.fn(),
    upsertRow: vi.fn(),
    deleteRow: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new TenantTtsConfigAdminController(service as never, providerConnectionService as never, cls as never);
  return { controller, service, providerConnectionService };
}

describe('TenantTtsConfigAdminController — scoping', () => {
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

  it('lets a global admin target any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.getRow.mockResolvedValue({ tenantId: 't9', version: 0 });
    await controller.getRow('t9');
    expect(service.getRow).toHaveBeenCalledWith('t9');
  });

  it('400s when a global admin omits ?tenantId= and has no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.getEffective()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantTtsConfigAdminController — If-Match precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', version: 3 });
    await controller.updateRow({ defaultSpeed: 2.0, expectedVersion: 1 }, 2, undefined);
    expect(service.upsertRow).toHaveBeenCalledWith('t1', expect.objectContaining({ defaultSpeed: 2.0, expectedVersion: 2 }));
  });

  it('falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', version: 1 });
    await controller.updateRow({ expectedVersion: 0 }, undefined, undefined);
    expect(service.upsertRow).toHaveBeenCalledWith('t1', expect.objectContaining({ expectedVersion: 0 }));
  });
});

describe('TenantTtsConfigAdminController — platform catalog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET catalog delegates to getPlatformCatalog (tenant-agnostic — no tenant scoping)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const catalog = {
      providers: [
        { provider: 'azure', slug: 'azure-neural-voices', name: 'Azure Neural Voices', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
      ],
    };
    service.getPlatformCatalog.mockResolvedValue(catalog);

    await expect(controller.getCatalog()).resolves.toBe(catalog);
    expect(service.getPlatformCatalog).toHaveBeenCalledWith();
  });
});

describe('TenantTtsConfigAdminController — BYO credentials (facade over IProviderConnectionService)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getCredentials lists tts connections for the caller tenant, masked, endpoint from region/baseUrl per provider', async () => {
    const { controller, providerConnectionService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    providerConnectionService.list.mockResolvedValue([
      { provider: 'azure', region: 'eastus', baseUrl: null, hasKey: true, keyVersion: 2, enabled: true, updatedAt: '2026-07-28T00:00:00.000Z' },
      { provider: 'sarvam', region: null, baseUrl: 'https://vpc.sarvam', hasKey: false, keyVersion: null, enabled: false },
    ]);

    const res = await controller.getCredentials(undefined);

    expect(providerConnectionService.list).toHaveBeenCalledWith('tts', 't1');
    expect(res).toEqual([
      { provider: 'azure', endpoint: 'eastus', enabled: true, hasKey: true, keyVersion: 2, updatedAt: '2026-07-28T00:00:00.000Z' },
      { provider: 'sarvam', endpoint: 'https://vpc.sarvam', enabled: false, hasKey: false, keyVersion: null },
    ]);
  });

  it('setCredential creates (expectedVersion 0) when no row exists yet, mapping endpoint to region for azure', async () => {
    const { controller, providerConnectionService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    providerConnectionService.getRow.mockResolvedValue({ version: 0 });
    providerConnectionService.upsertRow.mockResolvedValue({
      provider: 'azure',
      region: 'eastus',
      baseUrl: null,
      hasKey: true,
      keyVersion: 1,
      enabled: true,
    });

    const res = await controller.setCredential('azure', { apiKey: 'k', endpoint: 'eastus' }, undefined);

    expect(providerConnectionService.getRow).toHaveBeenCalledWith('tts', 'azure', 't1');
    expect(providerConnectionService.upsertRow).toHaveBeenCalledWith('tts', 'azure', { apiKey: 'k', enabled: true, region: 'eastus' }, 't1', 0);
    expect(res).toEqual({ provider: 'azure', endpoint: 'eastus', enabled: true, hasKey: true, keyVersion: 1 });
  });

  it('setCredential rotates (CAS on the current version) when a row already exists, mapping endpoint to baseUrl for sarvam', async () => {
    const { controller, providerConnectionService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    providerConnectionService.getRow.mockResolvedValue({ version: 3 });
    providerConnectionService.upsertRow.mockResolvedValue({
      provider: 'sarvam',
      region: null,
      baseUrl: 'https://vpc.sarvam',
      hasKey: true,
      keyVersion: 2,
      enabled: true,
    });

    const res = await controller.setCredential('sarvam', { apiKey: 'rotated', endpoint: 'https://vpc.sarvam' }, undefined);

    expect(providerConnectionService.upsertRow).toHaveBeenCalledWith(
      'tts',
      'sarvam',
      { apiKey: 'rotated', enabled: true, baseUrl: 'https://vpc.sarvam' },
      't1',
      3,
    );
    expect(res).toMatchObject({ provider: 'sarvam', hasKey: true });
  });

  it('setCredential defaults enabled to true and never surfaces the key on the response', async () => {
    const { controller, providerConnectionService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    providerConnectionService.getRow.mockResolvedValue({ version: 0 });
    providerConnectionService.upsertRow.mockResolvedValue({
      provider: 'azure',
      region: null,
      baseUrl: null,
      hasKey: true,
      keyVersion: 1,
      enabled: true,
    });

    const res = await controller.setCredential('azure', { apiKey: 'super-secret' }, undefined);

    expect(providerConnectionService.upsertRow).toHaveBeenCalledWith('tts', 'azure', { apiKey: 'super-secret', enabled: true }, 't1', 0);
    expect(JSON.stringify(res)).not.toContain('super-secret');
  });

  it('removeCredential delegates scoped to the caller tenant', async () => {
    const { controller, providerConnectionService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    providerConnectionService.deleteRow.mockResolvedValue(undefined);
    await controller.removeCredential('sarvam', undefined);
    expect(providerConnectionService.deleteRow).toHaveBeenCalledWith('tts', 'sarvam', 't1');
  });

  it('rejects a tenant admin managing credentials for another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getCredentials('t2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
