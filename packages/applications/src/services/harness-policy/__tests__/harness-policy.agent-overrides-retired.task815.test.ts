/**
 * TASK-815 / OD-12 — the per-agent harness-override tier is RETIRED, not moved.
 *
 * `getEffectivePolicy` used to run `applyAgentOverrides` on EVERY return path:
 * given a `consultationId` it resolved the consultation's department, then that
 * department's default `DepartmentAgent`, and layered that row's
 * `harnessOverrides` (tenant-tier keys only) on top of the resolved policy,
 * stamping an `overridesSource` provenance block on the response.
 *
 * The owner decision was to retire the tier outright rather than repoint it: a
 * per-agent override layer has no successor in the workflow substrate, where a
 * node's safety envelope is the node's own config and the tenant's harness
 * policy is the tenant's. Resolution is therefore back to the three tiers it
 * had before that overlay existed.
 *
 * A retirement needs a test for the same reason a repoint does: this file is
 * what stops the tier being quietly re-added, and what proves it left cleanly
 * rather than by accident. It replaces `harness-policy.agent-overrides.test.ts`,
 * which asserted the retired behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const CONSULTATION = 'consultation-1';

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
  );
}

function tenantOwnRow() {
  return HarnessPolicyFactory.CreateHarnessPolicy({
    tenantId: TENANT,
    coverageThreshold: 0.6,
    entityFaithfulnessThreshold: 0.7,
    maxRegen: 2,
    gateSlaSeconds: 3600,
    gateEscalationSeconds: 1800,
    toolAllowlist: ['nlp'],
    textProvider: 'tenant-prov',
    textModel: 'tenant-model',
  });
}

describe('OD-12 — the per-agent harnessOverrides tier is gone', () => {
  let service: HarnessPolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    policyRepository.findForExactTenant.mockResolvedValue(tenantOwnRow());
    policyRepository.findSystemDefault.mockResolvedValue(null);
    service = makeService();
  });

  it('the service no longer takes the repositories the overlay needed', () => {
    // The overlay's two `@Optional()` trailing dependencies — a consultation
    // repository (to find the department) and a department-agent repository (to
    // find its default agent) — were its ONLY reason to exist on this service.
    // Constructing with eight arguments is what proves they left.
    expect(HarnessPolicyService.length).toBe(8);
  });

  it('a consultationId no longer changes the resolved policy', async () => {
    const withConsultation = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });
    const without = await service.getEffectivePolicy(TENANT);

    expect(withConsultation.coverageThreshold).toBe(without.coverageThreshold);
    expect(withConsultation.entityFaithfulnessThreshold).toBe(without.entityFaithfulnessThreshold);
    expect(withConsultation.maxRegen).toBe(without.maxRegen);
    expect(withConsultation.gateSlaSeconds).toBe(without.gateSlaSeconds);
    expect(withConsultation.toolAllowlist).toEqual(without.toolAllowlist);
    expect(withConsultation.source).toBe(without.source);
  });

  it('serves the tenant row unmodified — resolution is code default -> SYSTEM -> tenant', async () => {
    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });

    expect(result.source).toBe('tenant');
    expect(result.coverageThreshold).toBe(0.6);
    expect(result.entityFaithfulnessThreshold).toBe(0.7);
    expect(result.maxRegen).toBe(2);
    expect(result.toolAllowlist).toEqual(['nlp']);
  });

  it('never stamps an overridesSource provenance block', async () => {
    // The Python `fetch_policy` activity used to read this off the raw response
    // to attribute a flagged draft to an agent. It no longer does, and the field
    // is gone from `HarnessPolicyResponse` — so an unexpected reappearance here
    // means the tier came back.
    const result = await service.getEffectivePolicy(TENANT, { consultationId: CONSULTATION });
    expect(result).not.toHaveProperty('overridesSource');
  });
});
