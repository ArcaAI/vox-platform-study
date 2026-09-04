/**
 * ProviderConnectionController unit tests (TASK-862).
 *
 * CASL `@Authorize` + `If-Match` are exercised by the guard/interceptor (+ e2e).
 * These cover the controller's OWN logic: the `:service` segment guard, tenant
 * vs. super-admin scoping, and that the test-connection route delegates to the
 * ephemeral `ProviderConnectionProbe` (never to the write path).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProviderConnectionController } from '../ai-provider-connection.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = { list: vi.fn(), getRow: vi.fn(), upsertRow: vi.fn(), deleteRow: vi.fn() };
  const probe = { test: vi.fn() };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new ProviderConnectionController(service as never, probe as never, cls as never);
  return { controller, service, probe };
}

describe('ProviderConnectionController — test connection (ephemeral)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the probe scoped to the caller tenant and never touches the write path', async () => {
    const { controller, probe, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    probe.test.mockResolvedValue({ ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' });

    const res = await controller.testConnection('llm', 'azure', { apiKey: 'k', baseUrl: 'https://x.openai.azure.com' }, undefined);

    expect(res.ok).toBe(true);
    expect(probe.test).toHaveBeenCalledWith('llm', 'azure', 't1', { apiKey: 'k', baseUrl: 'https://x.openai.azure.com' });
    expect(service.upsertRow).not.toHaveBeenCalled();
  });

  it('lets a super admin probe the SYSTEM tier via ?tenantId=', async () => {
    const { controller, probe } = makeController({ user: SUPER });
    probe.test.mockResolvedValue({ ok: true, message: 'ok', probe: 'reachability', source: 'platform' });
    await controller.testConnection('llm', 'lm-studio', {}, '00000000-0000-0000-0000-000000000000');
    expect(probe.test).toHaveBeenCalledWith('llm', 'lm-studio', '00000000-0000-0000-0000-000000000000', {});
  });

  it('rejects a tenant admin probing another tenant', async () => {
    const { controller, probe } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.testConnection('llm', 'azure', { apiKey: 'k' }, 't2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(probe.test).not.toHaveBeenCalled();
  });

  it('400s an unknown service segment before reaching the probe', async () => {
    const { controller, probe } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.testConnection('not-a-service', 'azure', { apiKey: 'k' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(probe.test).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionController — scoping on the CRUD routes', () => {
  it('pins a tenant admin to their CLS tenant on list', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.list.mockResolvedValue([]);
    await controller.list('tts', undefined);
    expect(service.list).toHaveBeenCalledWith('tts', 't1');
  });
});
