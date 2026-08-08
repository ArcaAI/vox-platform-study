import { describe, expect, it, vi } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import {
  ARCAAI_CLINICAL_TEMPLATES,
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
      // TASK-634 Phase 8b — the four departments that complete v1's eleven.
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
    expect(createdTemplates).toHaveLength(ARCAAI_CLINICAL_TEMPLATES.length);
    expect(createdTemplates.slice(0, 2).every((template) => template.departmentId === departmentIds.SURG)).toBe(true);
    expect(createdTemplates.at(-1)?.departmentId).toBeNull();
  });
});
