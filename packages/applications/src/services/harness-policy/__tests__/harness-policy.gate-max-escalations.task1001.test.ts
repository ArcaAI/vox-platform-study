/**
 * TASK-1001 wave 5 (owner decision 2026-09-23) — `gateMaxEscalations`: how many SLA breaches the
 * clinician gate records before it ABANDONS (the consultation is then closed unsigned). The owner's
 * "close the session after 5 min with no approval" is SYSTEM `gateSlaSeconds = 300` +
 * `gateMaxEscalations = 1`.
 *
 * Nullable and tenant-owned: `null` = no opinion, so a tenant row created by an unrelated edit
 * (a clinical threshold) must NOT freeze the bound — it widens to SYSTEM on absence, the same
 * cascade `mcpToolsEnabled` follows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, McpServerFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};
const policyChangeRepository = { create: vi.fn(async (entity: unknown) => entity) };
const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
const mcpServerRepository = { findAll: vi.fn() };

const clsFor = (tenantId: string) => ({
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return tenantId;
    if (key === 'user') return { id: USER };
    return undefined;
  }),
});

function makeService(tenantId = TENANT): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    clsFor(tenantId) as never,
    undefined,
    undefined,
    mcpServerRepository as never,
  );
}

const systemPolicy = (overrides: Record<string, unknown> = {}) =>
  HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: SYSTEM_TENANT_ID, ...overrides } as never);

const tenantPolicy = (overrides: Record<string, unknown> = {}) =>
  HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, ...overrides } as never);

beforeEach(() => {
  vi.clearAllMocks();
  policyRepository.findForExactTenant.mockResolvedValue(null);
  policyRepository.findSystemDefault.mockResolvedValue(null);
  mcpServerRepository.findAll.mockResolvedValue([]);
});

describe('TASK-1001 wave 5 — gateMaxEscalations resolves tenant → SYSTEM', () => {
  it('serves the SYSTEM value when the tenant has no row', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateMaxEscalations: 1, gateSlaSeconds: 300 }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateMaxEscalations).toBe(1);
    expect(effective.gateSlaSeconds).toBe(300);
  });

  it('a tenant row with NO opinion (null) inherits the SYSTEM bound', async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ coverageThreshold: 0.5 }));
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateMaxEscalations: 1 }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateMaxEscalations).toBe(1);
  });

  it("a tenant's own bound wins", async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ gateMaxEscalations: 2 }));
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateMaxEscalations: 1 }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateMaxEscalations).toBe(2);
  });

  it('null on both tiers stays null — the harness keeps its own bound', async () => {
    const effective = await makeService().getEffectivePolicy(TENANT);
    expect(effective.gateMaxEscalations).toBeNull();
  });

  it('a tenant admin may set it (not a super-admin-only knob)', async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy());

    await expect(makeService().updatePolicy({ gateMaxEscalations: 1, expectedVersion: 1 } as never)).resolves.toBeDefined();
  });

  it('refuses a bound of 0 — a gate must wait at least once', () => {
    const policy = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, gateMaxEscalations: 0 } as never);
    expect(() => policy.validate()).toThrow(/at least 1/);
  });
});
