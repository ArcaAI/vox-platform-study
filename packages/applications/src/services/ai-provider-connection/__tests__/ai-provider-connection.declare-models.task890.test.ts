/**
 * TASK-890 §3.7a — `AiProviderConnectionService.declareModels`.
 *
 * OD-A: a tenant admin picks provider AND model in one act. The connection row
 * already says WHERE the vendor account is; this says WHICH models it serves,
 * and each one becomes a TENANT-OWNED `AiModel` row carrying
 * `sourceConnectionId` as its provenance.
 *
 * What these tests pin, and why each matters:
 *
 *  - the row shape (CLOUD, NOT_APPLICABLE availability, generated slug,
 *    provenance) — because the catalogue, the publish gate and the wire builder
 *    all read those fields and none of them re-derives them;
 *  - **P-29, the slug shadow**: `AiModel` uniqueness is `(tenantId, slug)`, so a
 *    tenant row named like a SYSTEM row silently shadows it for every by-slug
 *    resolver in that tenant. The declaration REFUSES with 409 and writes
 *    nothing — a partially-applied declaration would be worse than none;
 *  - the declaration is a full REPLACEMENT: an entry that leaves the list is
 *    soft-deleted, so the tenant's list and the rows agree;
 *  - the two 403s (a SYSTEM connection, a non-BYO provider) and the fact that
 *    this path never asks for platform admin — REQ-5 keeps the REGISTRY
 *    platform-only, not the tenant's own declarations.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AiDeploymentKind, AiModelAvailability, AiProviderConnectionFactory, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT_A = 'tenant-aaa';

function connectionRow(overrides: { tenantId?: string; provider?: string; service?: string; enabled?: boolean } = {}) {
  const row = AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? TENANT_A,
    service: overrides.service ?? 'llm',
    provider: overrides.provider ?? 'azure',
    baseUrl: 'https://acme.openai.azure.com',
    enabled: overrides.enabled ?? true,
    encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: 3,
  } as any);
  return row;
}

function makeService(opts: { connection?: unknown; systemSlugs?: string[]; existing?: any[] } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(opts.connection === undefined ? connectionRow() : opts.connection),
    findByTenantIdAndService: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const models = {
    findBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === SYSTEM_TENANT_ID && (opts.systemSlugs ?? []).includes(slug) ? ({ id: `sys-${slug}`, slug, tenantId } as any) : null,
    ),
    findBySourceConnection: vi.fn(async () => opts.existing ?? []),
    create: vi.fn(async (e: any) => e),
    update: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(async () => undefined),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    // A TENANT admin — deliberately not a super admin: declaring your own
    // models must not require platform admin (REQ-5).
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['TENANT_ADMIN'] } : k === 'tenantId' ? TENANT_A : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets = { encrypt: vi.fn(), decrypt: vi.fn(), supportsTransit: vi.fn(() => true) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, undefined, models as any);
  return { svc, repo, models, emitter };
}

const AZURE_TWO = {
  models: [
    { wireModelId: 'gpt-4o-mini', name: 'GPT-4o mini (prod)', taskType: ModelTaskType.TEXT_GENERATION },
    { wireModelId: 'gpt-4.1', name: 'GPT-4.1', taskType: ModelTaskType.TEXT_GENERATION },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('declareModels — materialising tenant-owned rows', () => {
  it('creates one CLOUD tenant row per declared deployment, with provenance and a generated slug', async () => {
    const { svc, models } = makeService();

    const response = await svc.declareModels('llm', 'azure', AZURE_TWO as any);

    expect(models.create).toHaveBeenCalledTimes(2);
    const created = models.create.mock.calls.map(([entity]: [any]) => entity);
    expect(created.map((e: any) => e.slug)).toEqual(['azure-gpt-4o-mini', 'azure-gpt-4-1']);
    for (const entity of created) {
      expect(entity.tenantId).toBe(TENANT_A);
      expect(entity.sourceConnectionId).toBeTruthy();
      expect(entity.deploymentKind).toBe(AiDeploymentKind.CLOUD);
      expect(entity.availability).toBe(AiModelAvailability.NOT_APPLICABLE);
      expect(entity.provider).toBe('azure');
    }
    expect(created[0].wireModelId).toBe('gpt-4o-mini');
    // The projection the console reads back.
    expect(response.models?.map((m) => m.wireModelId)).toEqual(['gpt-4o-mini', 'gpt-4.1']);
  });

  it('REFUSES a declaration whose generated slug shadows a SYSTEM row, and writes nothing (P-29)', async () => {
    const { svc, models } = makeService({ systemSlugs: ['azure-gpt-4-1'] });

    const error = await svc.declareModels('llm', 'azure', AZURE_TWO as any).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('BYO_SLUG_SHADOWS_PLATFORM');
    expect(body.slug).toBe('azure-gpt-4-1');
    expect(body.systemModelId).toBe('sys-azure-gpt-4-1');
    expect(body.suggestedSlug).toBe('byo-azure-gpt-4-1');
    // Not one row — a partial declaration is worse than a refused one.
    expect(models.create).not.toHaveBeenCalled();
    expect(models.softDelete).not.toHaveBeenCalled();
  });

  it('is a full REPLACEMENT: a row whose entry left the list is soft-deleted', async () => {
    const existing = [
      { id: 'row-mini', slug: 'azure-gpt-4o-mini', wireModelId: 'gpt-4o-mini', name: 'GPT-4o mini', taskType: ModelTaskType.TEXT_GENERATION },
      { id: 'row-41', slug: 'azure-gpt-4-1', wireModelId: 'gpt-4.1', name: 'GPT-4.1', taskType: ModelTaskType.TEXT_GENERATION },
    ];
    const { svc, models } = makeService({ existing });

    await svc.declareModels('llm', 'azure', { models: [AZURE_TWO.models[0]] } as any);

    expect(models.softDelete).toHaveBeenCalledTimes(1);
    // No cross-tenant lane: the caller acts on its OWN tenant, so the write
    // goes through the scoped extended client (tx `undefined`).
    expect(models.softDelete).toHaveBeenCalledWith('row-41', 'u1', undefined);
    expect(models.create).not.toHaveBeenCalled();
  });

  it('403s a SYSTEM connection, naming where platform models are declared instead', async () => {
    const { svc, models } = makeService();
    const error = await svc.declareModels('llm', 'azure', AZURE_TWO as any, SYSTEM_TENANT_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as Error).message).toContain('/admin/ai-models');
    expect(models.create).not.toHaveBeenCalled();
  });

  it('403s a provider the tenant may not hold a row for (a platform engine)', async () => {
    const { svc, models } = makeService();
    const error = await svc.declareModels('llm', 'lm-studio', AZURE_TWO as any).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(models.create).not.toHaveBeenCalled();
  });

  it('400s a task type the service does not govern, and writes nothing', async () => {
    const { svc, models } = makeService();
    const error = await svc
      .declareModels('llm', 'azure', { models: [{ wireModelId: 'whisper-1', name: 'W', taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION }] } as any)
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('AUTOMATIC_SPEECH_RECOGNITION');
    expect(models.create).not.toHaveBeenCalled();
  });

  it('400s a payload that names the same wire id twice', async () => {
    const { svc, models } = makeService();
    const error = await svc
      .declareModels('llm', 'azure', { models: [AZURE_TWO.models[0], { ...AZURE_TWO.models[0], name: 'again' }] } as any)
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/gpt-4o-mini/);
    expect(models.create).not.toHaveBeenCalled();
  });

  it('404s when no connection row exists yet — the credential comes first', async () => {
    const { svc } = makeService({ connection: null });
    await expect(svc.declareModels('llm', 'azure', AZURE_TWO as any)).rejects.toThrow(/No connection row/);
  });

  it('broadcasts ONE ResourceUpdated sys-event describing the declaration', async () => {
    const { svc, emitter } = makeService();
    await svc.declareModels('llm', 'azure', AZURE_TWO as any);
    const declared = emitter.emit.mock.calls.filter(([, payload]: [string, any]) => payload?.data?.action === 'connection-models-declared');
    expect(declared).toHaveLength(1);
    expect(declared[0][1].data).toMatchObject({ service: 'llm', provider: 'azure', created: 2, updated: 0, removed: 0 });
  });
});

describe('the connection lifecycle around declared rows', () => {
  it('soft-deletes the declared rows when the CONNECTION is deleted (the FK is Restrict)', async () => {
    const existing = [{ id: 'row-mini', slug: 'azure-gpt-4o-mini', wireModelId: 'gpt-4o-mini', name: 'm', taskType: ModelTaskType.TEXT_GENERATION }];
    const { svc, models, repo } = makeService({ existing });

    await svc.deleteRow('llm', 'azure');

    expect(models.softDelete).toHaveBeenCalledWith('row-mini', 'u1', undefined);
    expect(repo.softDelete).toHaveBeenCalled();
  });
});
