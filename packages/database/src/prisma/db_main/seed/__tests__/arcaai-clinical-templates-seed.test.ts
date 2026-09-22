import { describe, expect, it, vi } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  seedArcaaiClinicalTemplates,
} from '../07b-arcaai-clinical-templates';

describe('ArcaAI clinical template department references', () => {
  it('uses persisted department IDs resolved by tenant and code', async () => {
    const departmentIds = {
      GEN: 'persisted-gen-id',
      SURG: 'persisted-surg-id',
      RHEUM: 'persisted-rheum-id',
      NEUR: 'persisted-neur-id',
      ORTH: 'persisted-orth-id',
      HEME: 'persisted-heme-id',
      BREN: 'persisted-bren-id',
      // The four departments that complete v1's eleven.
      DERM: 'persisted-derm-id',
      DIET: 'persisted-diet-id',
      NEPH: 'persisted-neph-id',
      SONC: 'persisted-sonc-id',
    };
    const findMany = vi.fn().mockResolvedValue(
      Object.entries(departmentIds).map(([code, id]) => ({ code, id })),
    );
    const promptTemplateUpsert = vi.fn().mockResolvedValue({});
    const promptVersionUpsert = vi.fn().mockResolvedValue({});
    const client = {
      department: { findMany },
      promptTemplate: { upsert: promptTemplateUpsert },
      promptVersion: { upsert: promptVersionUpsert },
    } as never;

    await seedArcaaiClinicalTemplates(client);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        code: { in: Object.keys(departmentIds) },
      },
      select: { id: true, code: true },
    });

    const createdTemplates = promptTemplateUpsert.mock.calls.map(([args]) => args.create);
    // TASK-1001 — the clinical corpus PLUS the one shared output-language policy row. The policy
    // is deliberately NOT a member of `ARCAAI_CLINICAL_TEMPLATES`: that set is pinned at 22+1
    // rows each carrying v1/v2/v3, and the policy is a single row with a single version. It is
    // seeded here because it is ArcaAI tenant content that the department agents point at.
    expect(createdTemplates).toHaveLength(ARCAAI_CLINICAL_TEMPLATES.length + 1);
    expect(createdTemplates.slice(0, 2).every((template) => template.departmentId === departmentIds.SURG)).toBe(true);

    const policy = createdTemplates.find((template) => template.id === ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(policy, 'the shared output-language policy row is not seeded').toBeDefined();
    // Tenant-wide, not per-department: one row every department agent points at, so a tenant
    // changes its note language by editing ONE row rather than 22.
    expect(policy!.departmentId).toBeNull();

    // The pre-summary row is department-less too, and remains so.
    const preSummary = createdTemplates.filter((template) => template.departmentId === null);
    expect(preSummary.length, 'exactly two department-less rows: the pre-summary and the policy').toBe(2);
  });
});
