import { describe, expect, it } from 'vitest';
import { TenantPlan } from '../../../../generated/core-prisma-client/client.js';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { ALL_TENANTS } from '../05-tenant';

/**
 * Owner decision OD-2 (TASK-766, 2026-08-20): "assign the ArcaAI tenant
 * ENTERPRISE." Every other seeded tenant keeps `plan = null` (resolves
 * ungated-legacy per `resolveEntitlements`'s Q3 rule) — only ArcaAI is a
 * commercially-modelled, plan-gated tenant on day one.
 */
describe('Tenant seed — plan assignment (TASK-766 OD-2)', () => {
  const byId = (id: string) => ALL_TENANTS.find((t) => t.id === id);

  it('assigns the ArcaAI customer tenant plan = ENTERPRISE', () => {
    const arcaai = byId(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
    expect(arcaai).toBeDefined();
    expect(arcaai).toMatchObject({ plan: TenantPlan.ENTERPRISE });
  });

  it('leaves the SYSTEM tenant plan unset (null) — it is a config tier, never gated', () => {
    const system = byId(SYSTEM_TENANT_ID);
    expect(system).toBeDefined();
    expect((system as { plan?: unknown }).plan).toBeUndefined();
  });

  it('leaves the Global customer tenant plan unset (null) — no plan assigned by the owner ruling', () => {
    const global = byId(SEED_TENANT_ID);
    expect(global).toBeDefined();
    expect((global as { plan?: unknown }).plan).toBeUndefined();
  });
});
