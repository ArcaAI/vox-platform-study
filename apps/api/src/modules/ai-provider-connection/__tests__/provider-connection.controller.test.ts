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
  const service = { list: vi.fn(), getRow: vi.fn(), upsertRow: vi.fn(), deleteRow: vi.fn(), declareModels: vi.fn() };
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

/**
 * TASK-890 §3.7a — `PUT :service/:provider/models`.
 *
 * The route is thin on purpose: the class gate, the slug-shadow refusal and the
 * replacement semantics all live in the service, where one rule serves every
 * surface. What the CONTROLLER owns is the `:service` guard and the tenant
 * scoping, and both are pinned here — a tenant admin declaring models for
 * ANOTHER tenant would be the one way this route could leak.
 */
describe('ProviderConnectionController — declaring a connection\u2019s models', () => {
  beforeEach(() => vi.clearAllMocks());

  const BODY = { models: [{ wireModelId: 'gpt-4o-mini', name: 'GPT-4o mini', taskType: 'TEXT_GENERATION' }] };

  it('delegates to the service scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.declareModels.mockResolvedValue({ provider: 'azure', models: [] });

    await controller.declareModels('llm', 'azure', BODY as never, undefined);

    expect(service.declareModels).toHaveBeenCalledWith('llm', 'azure', BODY, 't1');
  });

  it('rejects a tenant admin declaring models on another tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.declareModels('llm', 'azure', BODY as never, 't2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.declareModels).not.toHaveBeenCalled();
  });

  it('400s an unknown service segment before reaching the service', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.declareModels('not-a-service', 'azure', BODY as never, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.declareModels).not.toHaveBeenCalled();
  });
});
