/**
 * WorkflowInvariantRuleRepository — unit tests (b).
 *
 * The two methods that are not plain CRUD, and the reasons each exists:
 *
 *  - `findApplicable(tenantId, paletteKey)` must return the tenant's OWN rows
 *    UNIONed with the SYSTEM platform register, because a tenant validating its
 *    own graph against only the rules IT authored would silently under-enforce
 *    the platform's safety rules. The union is TWO explicit-`tenantId` reads,
 *    not one `OR` — mirroring the `HarnessPolicy` cascade (`PipelinePolicy`
 *    was the exemplar named here until TASK-882 retired it) —
 *    since the tenant-scope extension pins an explicit `where.tenantId` to the
 *    caller's own context tenant, and the SYSTEM rows live under a different id.
 *  - Palette-agnostic rows (`paletteKey: null`, the structural class) apply to
 *    EVERY palette, so they must be in scope for any requested palette.
 *  - `findMaxRuleVersion` is what stamps `ValidationReport.ruleSetVersion` and
 *    what the re-validation sweep compares against; `0` for an empty rule set
 *    keeps "no rules" distinguishable from "version 1".
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { WorkflowInvariantRuleRepository } from '../generated/core/WorkflowInvariantRuleRepository';
import { ResourceStatusType, WorkflowRulePredicateType, WorkflowRuleSeverity } from '../../enums';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const TENANT = '50000000-0000-0000-0000-000000000001';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'a0000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT,
    ruleId: 'WF-S-001',
    registerRefs: [],
    title: 'The graph is a DAG.',
    rationale: null,
    predicateType: WorkflowRulePredicateType.ACYCLIC,
    predicateConfig: {},
    paletteKey: null,
    severity: WorkflowRuleSeverity.ERROR,
    ruleVersion: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    version: 1,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function makeRepo() {
  const delegate = { findMany: vi.fn() };
  const uow = { getDatabaseService: () => ({ workflowInvariantRule: delegate }) };
  const repo = new WorkflowInvariantRuleRepository(uow as never);
  return { repo, delegate };
}

describe('WorkflowInvariantRuleRepository.findApplicable', () => {
  it('unions the SYSTEM register with the tenant\'s own rows', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany
      // first call = own tenant
      .mockResolvedValueOnce([row({ tenantId: TENANT, ruleId: 'WF-T-900', paletteKey: 'summarization' })])
      // second call = SYSTEM
      .mockResolvedValueOnce([row({ ruleId: 'WF-S-001' })]);

    const rules = await repo.findApplicable(TENANT, 'summarization');

    expect(rules.map((r) => r.ruleId).sort()).toEqual(['WF-S-001', 'WF-T-900']);
    expect(delegate.findMany).toHaveBeenCalledTimes(2);
  });

  it('pins an explicit tenantId on BOTH reads, and filters to ENABLED only', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany.mockResolvedValue([]);

    await repo.findApplicable(TENANT, 'summarization');

    const [ownCall, systemCall] = delegate.findMany.mock.calls;
    expect(ownCall[0].where).toEqual(
      expect.objectContaining({ tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    );
    expect(systemCall[0].where).toEqual(
      expect.objectContaining({ tenantId: SYSTEM_TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    );
  });

  it('includes palette-agnostic (paletteKey: null) rows for a specific palette', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany.mockResolvedValue([]);

    await repo.findApplicable(TENANT, 'summarization');

    for (const call of delegate.findMany.mock.calls) {
      expect(call[0].where).toEqual(
        expect.objectContaining({ OR: [{ paletteKey: 'summarization' }, { paletteKey: null }] }),
      );
    }
  });

  it('does not issue a second read when the caller IS the SYSTEM tenant', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany.mockResolvedValueOnce([row()]);

    const rules = await repo.findApplicable(SYSTEM_TENANT, 'summarization');

    expect(rules).toHaveLength(1);
    expect(delegate.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowInvariantRuleRepository.findMaxRuleVersion', () => {
  it('returns the highest ruleVersion across the SYSTEM + tenant union', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany
      .mockResolvedValueOnce([row({ tenantId: TENANT, ruleId: 'WF-T-900', ruleVersion: 7 })])
      .mockResolvedValueOnce([row({ ruleVersion: 3 })]);

    await expect(repo.findMaxRuleVersion(TENANT, 'summarization')).resolves.toBe(7);
  });

  it('returns 0 for an empty rule set, so "no rules" is distinguishable from version 1', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany.mockResolvedValue([]);

    await expect(repo.findMaxRuleVersion(TENANT, 'summarization')).resolves.toBe(0);
  });
});
