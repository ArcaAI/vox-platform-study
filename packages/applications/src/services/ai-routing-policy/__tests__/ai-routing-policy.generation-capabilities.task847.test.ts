/**
 * finding F-32 — `resolveGenerationCapabilities`, against mocked REPOSITORIES.
 *
 * The workflow-definition suite mocks this service at the seam; this file exercises the thing
 * that seam stands for. What is pinned here:
 *
 *   * the capability set is READ off the resolved `AiModel` row's `_metadata` — real data, not a
 *     per-provider table in TypeScript;
 *   * the cascade is request tenant → SYSTEM, two tiers, and the Global CUSTOMER tenant
 *     `50000000-…` cannot enter it — asserted on the tenant-id SET the repository is handed, so a
 *     resolver that quietly added a third tier would fail here rather than pass by coincidence;
 *   * both `providerConfigRef` shapes resolve (`routingPolicyId` pin, `taskKey` election);
 *   * every miss is UNKNOWN (`supportedGenerationParams: undefined`), never a throw — a
 *     capability question must not be the thing that fails a publish.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { AiRoutingPolicyFactory, AiRoutingPolicyStatus, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';

const TENANT = 'tenant-abc';
/** The platform-admin playground. A real CUSTOMER, never a config tier. */
const GLOBAL_CUSTOMER_TENANT = '50000000-0000-0000-0000-000000000000';

/** What `apps/text` can actually deliver — the value the SYSTEM generation rows are seeded with. */
const TEXT_PLANE = ['temperature', 'maxTokens', 'topP'];

function makeConfig(overrides: Record<string, any> = {}) {
  const row = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'text.finalize',
    displayName: overrides.displayName ?? null,
    providerConnectionId: null,
    modelId: overrides.model === null ? null : `model:${overrides.model ?? 'lms-gemma-4-e2b-it-qat'}`,
    isDefault: overrides.isDefault ?? true,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    policyVersion: overrides.policyVersion ?? 1,
    status: overrides.status ?? AiRoutingPolicyStatus.ACTIVE,
    matchJson: null as any,
    fallbackJson: null as any,
  });
  if (overrides.id) (row as any)._id = overrides.id;
  return row;
}

/**
 * `modelCapabilities` maps a model SLUG to the `_metadata.supportedGenerationParams` its registry
 * row declares. A slug absent from the map declares nothing — which is the UNKNOWN case, not the
 * "supports nothing" case.
 */
function makeService(opts: { rows?: any[]; modelCapabilities?: Record<string, string[]> } = {}) {
  const rows = opts.rows ?? [];
  const caps = opts.modelCapabilities ?? {};

  const repo = {
    // The non-lane read path `readPolicies` uses for a pinned id. Filters honestly so a pinned id
    // that names another tenant's row genuinely resolves to nothing.
    findAll: vi.fn().mockImplementation(async ({ filters }: any) => rows.filter((r: any) => (filters?.id ? r.id === filters.id : true))),
    // The cascade read. The mock honours the tenant-id SET it is handed, which is what makes the
    // cascade assertions meaningful.
    findCandidates: vi
      .fn()
      .mockImplementation(async (tenantIds: string[], taskKey: string) =>
        rows.filter(
          (r: any) => tenantIds.includes(r.tenantId) && r.taskKey === taskKey && r.status === AiRoutingPolicyStatus.ACTIVE && r.enabled !== false,
        ),
      ),
    clearDefaultFor: vi.fn(),
    create: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
  };
  const models = {
    findById: vi.fn().mockImplementation(async (id: string) => {
      const slug = String(id).replace(/^model:/, '');
      const declared = caps[slug];
      return { id, slug, metaData: declared ? { supportedGenerationParams: declared } : null };
    }),
    findBySlug: vi.fn(),
  };
  const providerConnections = { findById: vi.fn().mockResolvedValue(null) };
  const connections = { resolveConnection: vi.fn().mockResolvedValue({ source: 'tenant' }), findRow: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'] } : k === 'tenantId' ? TENANT : undefined)) };
  const db = { baseClient: { aiRoutingPolicy: { findMany: vi.fn().mockResolvedValue([]) } } };
  const unitOfWork = { runInTransaction: vi.fn() };

  const svc = new AiRoutingPolicyService(
    repo as any,
    providerConnections as any,
    models as any,
    connections as any,
    db as any,
    unitOfWork as any,
    { emit: vi.fn() } as any,
    cls as any,
  );
  return { svc, repo, models };
}

describe('F-32 — the capability set comes off the resolved AiModel row', () => {
  it('reads `_metadata.supportedGenerationParams` for a PINNED routing policy', async () => {
    const { svc } = makeService({
      rows: [makeConfig({ id: 'pol-1', displayName: 'Local summarization' })],
      modelCapabilities: { 'lms-gemma-4-e2b-it-qat': TEXT_PLANE },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-1' });

    expect(result.supportedGenerationParams).toEqual(TEXT_PLANE);
    // The label names the configuration AND the model, so an author can act on the problem.
    expect(result.label).toBe('Local summarization → lms-gemma-4-e2b-it-qat');
  });

  it('reads it for a TASK-KEY election too', async () => {
    const { svc } = makeService({
      rows: [makeConfig({ id: 'pol-1' })],
      modelCapabilities: { 'lms-gemma-4-e2b-it-qat': TEXT_PLANE },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'text.finalize' });
    expect(result.supportedGenerationParams).toEqual(TEXT_PLANE);
  });

  it('a model that DECLARES NOTHING is UNKNOWN, not "supports nothing"', async () => {
    // The whole severity split rests on this distinction: collapsing it would turn every
    // unprofiled configuration into a publish-blocking error.
    const { svc } = makeService({ rows: [makeConfig({ id: 'pol-1' })], modelCapabilities: {} });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-1' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });
});

describe('F-32 — the cascade is request tenant → SYSTEM, and nothing else', () => {
  it("prefers the TENANT's own configuration over the platform default", async () => {
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, id: 'pol-tenant', model: 'tenant-own-vllm' }),
        makeConfig({ tenantId: SYSTEM_TENANT_ID, id: 'pol-system', model: 'lms-gemma-4-e2b-it-qat' }),
      ],
      // The tenant's own endpoint honours MORE than the platform default can.
      modelCapabilities: { 'tenant-own-vllm': [...TEXT_PLANE, 'presencePenalty'], 'lms-gemma-4-e2b-it-qat': TEXT_PLANE },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'text.finalize' });
    expect(result.supportedGenerationParams).toContain('presencePenalty');
  });

  it('widens to SYSTEM only on ABSENCE of a tenant configuration', async () => {
    const { svc } = makeService({
      rows: [makeConfig({ tenantId: SYSTEM_TENANT_ID, id: 'pol-system' })],
      modelCapabilities: { 'lms-gemma-4-e2b-it-qat': TEXT_PLANE },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'text.finalize' });
    expect(result.supportedGenerationParams).toEqual(TEXT_PLANE);
  });

  it('hands the repository EXACTLY [requestTenant, SYSTEM] — never a third tier', async () => {
    const { svc, repo } = makeService({ rows: [makeConfig({ id: 'pol-1' })], modelCapabilities: {} });

    await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'text.finalize' });

    // The load-bearing assertion is the TIER SET, not the read options that
    // follow it (`resolveDefault` passes `includeParked` there since TASK-872).
    expect(repo.findCandidates.mock.calls[0]!.slice(0, 3)).toEqual([[TENANT, SYSTEM_TENANT_ID], 'text.finalize', undefined]);
    for (const call of repo.findCandidates.mock.calls) {
      expect(call[0]).not.toContain(GLOBAL_CUSTOMER_TENANT);
    }
  });

  it('the Global CUSTOMER tenant never supplies a capability set', async () => {
    // `50000000-…` holds a row that would answer differently. If it ever entered the cascade,
    // one customer's configuration would be describing every other tenant's graphs.
    const { svc } = makeService({
      rows: [makeConfig({ tenantId: GLOBAL_CUSTOMER_TENANT, id: 'pol-global', model: 'playground-model' })],
      modelCapabilities: { 'playground-model': [...TEXT_PLANE, 'seed', 'presencePenalty'] },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'text.finalize' });

    // Nothing resolved: the playground row is invisible to this tenant.
    expect(result.supportedGenerationParams).toBeUndefined();
    expect(result.label).toBe("taskKey 'text.finalize'");
  });

  it('a pinned id owned by the Global playground resolves to nothing for another tenant', async () => {
    const { svc } = makeService({
      rows: [makeConfig({ tenantId: GLOBAL_CUSTOMER_TENANT, id: 'pol-global' })],
      modelCapabilities: { 'lms-gemma-4-e2b-it-qat': TEXT_PLANE },
    });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-global' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });
});

describe('F-32 — every miss is UNKNOWN, never a throw', () => {
  it('an unresolvable pinned id answers UNKNOWN and names the reference', async () => {
    const { svc } = makeService({ rows: [], modelCapabilities: {} });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-missing' });
    expect(result.supportedGenerationParams).toBeUndefined();
    expect(result.label).toBe("routingPolicyId 'pol-missing'");
  });

  it('an unknown task key answers UNKNOWN rather than raising', async () => {
    // `getEffective` would throw on an unknown key; this path must not, because the authoring
    // schema is where a bad task key is refused.
    const { svc } = makeService({ rows: [], modelCapabilities: {} });

    const result = await svc.resolveGenerationCapabilities(TENANT, { taskKey: 'not.a.real.key' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });

  it('a configuration that names NO model answers UNKNOWN', async () => {
    const { svc } = makeService({ rows: [makeConfig({ id: 'pol-1', model: null })], modelCapabilities: {} });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-1' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });

  it('a repository failure answers UNKNOWN rather than propagating', async () => {
    const { svc, repo } = makeService({ rows: [], modelCapabilities: {} });
    repo.findAll.mockRejectedValue(new Error('db down'));

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-1' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });

  it('a non-array declaration is ignored rather than trusted', async () => {
    const { svc, models } = makeService({ rows: [makeConfig({ id: 'pol-1' })], modelCapabilities: {} });
    models.findById.mockResolvedValue({ id: 'model:x', slug: 'x', metaData: { supportedGenerationParams: 'temperature' } });

    const result = await svc.resolveGenerationCapabilities(TENANT, { routingPolicyId: 'pol-1' });
    expect(result.supportedGenerationParams).toBeUndefined();
  });
});
