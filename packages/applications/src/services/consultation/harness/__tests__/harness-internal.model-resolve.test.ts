/**
 * F11 — `GET /internal/harness/models/resolve`, the registry-model resolve the
 * durable `core.classify` node has been calling since TASK-864 against a route
 * that did not exist (measured against `apps/api/route-manifest.json`: the only
 * internal resolve routes were `/internal/agents/resolve` and
 * `/internal/harness/prompt-templates/:id/resolved`).
 *
 * The resolution is the platform's standard catalogue cascade — the tenant's own
 * BYO row first, the SYSTEM catalogue on ABSENCE only — mirroring
 * `AgentResolverService.modelBySlug`. It is NOT a widening: a slug that exists
 * only under another tenant resolves nothing and answers 404, exactly like an
 * unknown slug (404-over-403).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

function makeCls() {
  const set = vi.fn();
  return {
    cls: { run: vi.fn(async (cb: () => unknown) => cb()), set, get: vi.fn() },
    set,
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b0000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'gliner2-guardrails-pii-multi',
    taskType: 'TOKEN_CLASSIFICATION',
    sourceUri: 'fastino/GLiNER2-Guardrails-PII-Multi',
    sourceRevision: 'main',
    format: 'SAFETENSOR',
    libraryName: 'gliner2',
    servedBy: 'nlp',
    provider: 'built-in',
    wireModelId: null,
    computeType: 'float32',
    bucketPrefix: 'nlp/gliner2-guardrails-pii-multi/',
    primaryObject: null,
    metaData: { labelTaxonomy: { threshold: 0.5, labels: ['person', 'email'] } },
    ...overrides,
  };
}

function buildService(aiModelRepository: unknown, cls = makeCls().cls) {
  return new HarnessInternalService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    {} as never, // namedEntityRepository
    {} as never, // summaryMetaRepository
    {} as never, // promptAssemblyService
    {} as never, // promptTemplateRepository
    {} as never, // harnessAuditService
    cls as never, // cls
    undefined as never, // jobService
    undefined as never, // highlightRepository
    undefined as never, // assuranceService
    undefined as never, // configResolver
    undefined as never, // contextItemVersionRepository
    undefined as never, // secretsService
    undefined as never, // redisCache
    undefined as never, // transcriptSegmentRepository
    undefined as never, // harnessPolicyService
    undefined as never, // mcpServerRepository
    undefined as never, // usageLedgerService
    undefined as never, // notificationService
    undefined as never, // providerConnectionService
    undefined as never, // visitTypes
    aiModelRepository as never, // aiModelRepository
  );
}

describe('HarnessInternalService.resolveRegistryModel', () => {
  it('resolves the tenant BYO row first and never consults SYSTEM when it exists', async () => {
    const findBySlug = vi.fn(async (tenantId: string) => (tenantId === TENANT ? makeRow({ tenantId: TENANT, sourceUri: 'byo/pii' }) : makeRow()));
    const service = buildService({ findBySlug });

    const resolved = await service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT);

    expect(resolved.sourceUri).toBe('byo/pii');
    expect(resolved.tenantId).toBe(TENANT);
    expect(findBySlug).toHaveBeenCalledTimes(1);
    expect(findBySlug).toHaveBeenCalledWith(TENANT, 'gliner2-guardrails-pii-multi');
  });

  it('widens to the SYSTEM catalogue ONLY on absence of a tenant row', async () => {
    const findBySlug = vi.fn(async (tenantId: string) => (tenantId === SYSTEM_TENANT_ID ? makeRow() : null));
    const service = buildService({ findBySlug });

    const resolved = await service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT);

    expect(resolved.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(findBySlug).toHaveBeenNthCalledWith(1, TENANT, 'gliner2-guardrails-pii-multi');
    expect(findBySlug).toHaveBeenNthCalledWith(2, SYSTEM_TENANT_ID, 'gliner2-guardrails-pii-multi');
  });

  it('projects the wire shape the core.classify node consumes', async () => {
    const service = buildService({ findBySlug: vi.fn(async () => makeRow()) });

    const resolved = await service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT);

    expect(resolved).toMatchObject({
      slug: 'gliner2-guardrails-pii-multi',
      taskType: 'TOKEN_CLASSIFICATION',
      sourceUri: 'fastino/GLiNER2-Guardrails-PII-Multi',
      sourceRevision: 'main',
      // DERIVED from the bucket identity (TASK-890 §3.11), never a column read.
      localPath: '/mnt/models-bucket/nlp/gliner2-guardrails-pii-multi/',
      servedBy: 'nlp',
      provider: 'built-in',
      wireModelId: null,
      format: 'SAFETENSOR',
      computeType: 'float32',
      labelTaxonomy: { threshold: 0.5, labels: ['person', 'email'] },
    });
  });

  it('omits labelTaxonomy entirely when the row declares none — never an invented default', async () => {
    const service = buildService({ findBySlug: vi.fn(async () => makeRow({ metaData: {} })) });

    const resolved = await service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT);

    expect(resolved.labelTaxonomy).toBeUndefined();
  });

  it('answers 404 for an unknown slug — the same answer a foreign tenant’s row gets', async () => {
    const service = buildService({ findBySlug: vi.fn(async () => null) });

    await expect(service.resolveRegistryModel('ghost', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when the resolved row does not carry the REQUESTED task', async () => {
    const service = buildService({ findBySlug: vi.fn(async () => makeRow()) });

    await expect(service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT, 'TEXT_CLASSIFICATION')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('accepts a matching task filter', async () => {
    const service = buildService({ findBySlug: vi.fn(async () => makeRow()) });

    await expect(service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT, 'TOKEN_CLASSIFICATION')).resolves.toMatchObject({
      taskType: 'TOKEN_CLASSIFICATION',
    });
  });

  it('refuses a tenant-less or slug-less resolve (400) rather than reading SYSTEM unconditionally', async () => {
    const findBySlug = vi.fn();
    const service = buildService({ findBySlug });

    await expect(service.resolveRegistryModel('some-slug', '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resolveRegistryModel('', TENANT)).rejects.toBeInstanceOf(BadRequestException);
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('reads INSIDE a CLS tenant context — a service-token request carries none', async () => {
    const { cls, set } = makeCls();
    const service = buildService({ findBySlug: vi.fn(async () => makeRow()) }, cls);

    await service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT);

    expect(cls.run).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('tenantId', TENANT);
  });

  it('fails CLOSED with a 404 when the registry plane is unwired — selection is never substituted', async () => {
    const service = buildService(undefined);

    await expect(service.resolveRegistryModel('gliner2-guardrails-pii-multi', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});
