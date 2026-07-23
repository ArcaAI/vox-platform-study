/**
 * HarnessPolicyService — per-department-agent harness overrides (TASK-550).
 *
 * When `getEffectivePolicy` is called with a `consultationId`, the consultation's
 * department default `DepartmentAgent.harnessOverrides` is layered on top of the
 * resolved tenant/SYSTEM policy — tenant-tier keys only. Global-admin-only keys
 * that somehow got stored are DROPPED at read time (defense-in-depth), never
 * served. No consultation / no department / no default agent / a disabled agent /
 * a cross-tenant consultation all leave the policy byte-identical to today.
 *
 * Repositories are mocked; the REAL HarnessPolicyFactory runs so the base
 * resolution (tenant → SYSTEM overlay → code default) is exercised end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const CONSULTATION = 'consultation-1';
const DEPARTMENT = 'dept-1';

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};

const policyChangeRepository = { create: vi.fn(async (entity: unknown) => entity) };
const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };

const cls = {
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: USER };
    return undefined;
  }),
};

const consultationRepository = { findById: vi.fn() };
const departmentAgentRepository = { findDefaultForDepartment: vi.fn() };

function makeService(): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    undefined, // secretsService
    undefined, // aiTaskDefaultService
    undefined, // mcpServerRepository
    undefined, // effectiveSettings
    consultationRepository as never,
    departmentAgentRepository as never,
  );
}

/** A fully-populated tenant policy row (distinct threshold + gate values). */
function tenantOwnRow() {
  return HarnessPolicyFactory.CreateHarnessPolicy({
    tenantId: TENANT,
    coverageThreshold: 0.6,
    entityFaithfulnessThreshold: 0.7,
    maxRegen: 2,
    gateSlaSeconds: 3600,
    gateEscalationSeconds: 1800,
    toolAllowlist: ['nlp'],
    smrProvider: 'tenant-prov',
    smrModel: 'tenant-model',
  });
}

describe('HarnessPolicyService — per-agent harnessOverrides overlay', () => {
  let service: HarnessPolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    policyRepository.findForExactTenant.mockResolvedValue(tenantOwnRow());
    policyRepository.findSystemDefault.mockResolvedValue(null);
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT });
    service = makeService();
  });

  it('overlays every tenant-tier key from the department default agent on top of the tenant layer', async () => {
    departmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      slug: 'cardio-default',
      harnessOverrides: {
        coverageThreshold: 0.95,
        entityFaithfulnessThreshold: 0.99,
        maxRegen: 5,
        gateSlaSeconds: 7200,
        gateEscalationSeconds: 3600,
        toolAllowlist: ['nlp', 'smr'],
      },
    });

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.95);
    expect(result.entityFaithfulnessThreshold).toBe(0.99);
    expect(result.maxRegen).toBe(5);
    expect(result.gateSlaSeconds).toBe(7200);
    expect(result.gateEscalationSeconds).toBe(3600);
    expect(result.toolAllowlist).toEqual(['nlp', 'smr']);
    // provenance for observability
    expect(result.overridesSource).toEqual({
      agentId: 'agent-1',
      agentSlug: 'cardio-default',
      keys: expect.arrayContaining([
        'coverageThreshold',
        'entityFaithfulnessThreshold',
        'maxRegen',
        'gateSlaSeconds',
        'gateEscalationSeconds',
        'toolAllowlist',
      ]),
    });
    expect(departmentAgentRepository.findDefaultForDepartment).toHaveBeenCalledWith(TENANT, DEPARTMENT);
  });

  it('DROPS a stored global-admin-only key at read time (never served), warning', async () => {
    const warn = vi.spyOn((service as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn').mockImplementation(() => undefined);
    departmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-2',
      slug: 'sneaky',
      harnessOverrides: {
        coverageThreshold: 0.9,
        // global-admin-only — must NOT flow through the per-agent overlay
        safetyEnabled: false,
        smrModel: 'evil-model',
      },
    });

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.9); // tenant-tier key applied
    expect(result.safetyEnabled).toBe(true); // global-only dropped, base preserved
    expect(result.smrModel).toBe('tenant-model'); // global-only dropped, base preserved
    expect(result.overridesSource?.keys).toEqual(['coverageThreshold']);
    expect(result.overridesSource?.keys).not.toContain('safetyEnabled');
    expect(result.overridesSource?.keys).not.toContain('smrModel');
    expect(warn).toHaveBeenCalled();
  });

  it('no consultationId ⇒ identical to today (no overlay, no provenance)', async () => {
    departmentAgentRepository.findDefaultForDepartment.mockResolvedValue({ id: 'a', slug: 's', harnessOverrides: { coverageThreshold: 0.1 } });

    const result = await service.getEffectivePolicy(TENANT);

    expect(result.coverageThreshold).toBe(0.6); // tenant base untouched
    expect(result.overridesSource).toBeUndefined();
    expect(consultationRepository.findById).not.toHaveBeenCalled();
    expect(departmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('no default agent for the department ⇒ identical to today', async () => {
    departmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
  });

  it('agent with null harnessOverrides ⇒ identical to today', async () => {
    departmentAgentRepository.findDefaultForDepartment.mockResolvedValue({ id: 'a', slug: 's', harnessOverrides: null });

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
  });

  it('consultation without a departmentId ⇒ no overlay', async () => {
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, departmentId: null });

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
    expect(departmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('cross-tenant consultation ⇒ no overlay, no leak (404 semantics: read returns foreign row → skipped)', async () => {
    // Even if the tenant-scope extension were bypassed, the explicit tenant guard
    // must refuse to apply an overlay from a consultation the caller does not own.
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: 'other-tenant', departmentId: DEPARTMENT });

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
    expect(departmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('missing consultation row ⇒ no overlay (fail-safe)', async () => {
    consultationRepository.findById.mockResolvedValue(null);

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
  });

  it('a repository failure never sinks the policy read (best-effort overlay)', async () => {
    vi.spyOn((service as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn').mockImplementation(() => undefined);
    consultationRepository.findById.mockRejectedValue(new Error('db down'));

    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.coverageThreshold).toBe(0.6);
    expect(result.overridesSource).toBeUndefined();
  });
});
