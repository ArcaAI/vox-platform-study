/**
 * / OD-11 (2026-09-01) — `mcpToolsEnabled` is a PER-TENANT setting.
 *
 * It shipped as a super-admin-only knob: it sat in `SUPER_ADMIN_ONLY_POLICY_KEYS`,
 * so (a) a tenant PATCH was 403'd and (b) `getEffectivePolicy` OVERLAID the SYSTEM
 * value on top of any tenant row, meaning a tenant could never turn the MCP path
 * on for itself. OD-11 reverses that: it resolves on the standard
 * **tenant → SYSTEM** cascade, widening only on ABSENCE (`null` = "no opinion").
 *
 * Without this, authorization and console work still leave a silent
 * blocker — connectors configurable but nothing invocable.
 *
 * Also pinned here: `resolveMcpServers` must carry the TENANT's own connectors,
 * not only the SYSTEM-shared registry. A tenant admin who registers a connector
 * under OD-7 and never sees it reach the worker has been given a dead switch.
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

describe('OD-11 — mcpToolsEnabled resolves tenant → SYSTEM', () => {
  it("a tenant's own TRUE wins over a SYSTEM false (the tenant is no longer overlaid)", async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ mcpToolsEnabled: true }));
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: false }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.mcpToolsEnabled).toBe(true);
  });

  it("a tenant's own FALSE wins over a SYSTEM true — a tenant may opt OUT of MCP", async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ mcpToolsEnabled: false }));
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.mcpToolsEnabled).toBe(false);
  });

  it('a tenant row with NO opinion (null) widens to the SYSTEM default', async () => {
    // The footgun this pins: a tenant policy row is created on the first edit of
    // ANY knob (a clinical threshold, say). If a null were treated as an opinion,
    // that unrelated edit would silently switch MCP off for the tenant.
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ mcpToolsEnabled: null }));
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.mcpToolsEnabled).toBe(true);
  });

  it('stays OFF (null) when neither tier expresses an opinion — fail-safe default', async () => {
    policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy());
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy());

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.mcpToolsEnabled ?? null).toBeNull();
  });

  it('a tenant admin may PATCH it on its own policy row (no longer 403)', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: null }));

    const updated = await makeService().updatePolicy({ mcpToolsEnabled: true } as never, 1);

    expect(updated.mcpToolsEnabled).toBe(true);
  });

  it('a super admin still sets the SYSTEM platform default', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: null }));

    const updated = await makeService(SYSTEM_TENANT_ID).updateGlobalDefault({ mcpToolsEnabled: true } as never, 1);

    expect(updated.mcpToolsEnabled).toBe(true);
  });
});

describe('OD-7/OD-11 — the worker receives the tenant’s OWN connectors, not just SYSTEM', () => {
  it('resolveMcpServers scopes to [tenant, SYSTEM]', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));

    await makeService().getEffectivePolicy(TENANT);

    expect(mcpServerRepository.findAll).toHaveBeenCalledTimes(1);
    const where = (mcpServerRepository.findAll.mock.calls[0][0] as { where?: { tenantId?: unknown } })?.where;
    expect(where?.tenantId).toEqual({ in: [TENANT, SYSTEM_TENANT_ID] });
  });

  it("emits the tenant's own enabled connector alongside the SYSTEM-shared one", async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));
    mcpServerRepository.findAll.mockResolvedValue([
      McpServerFactory.CreateMcpServer({
        tenantId: SYSTEM_TENANT_ID,
        name: 'fhir-terminology',
        baseUrl: 'https://terminology.internal/mcp',
        enabled: true,
        toolAllowlist: ['validate_codes'],
      } as never),
      McpServerFactory.CreateMcpServer({
        tenantId: TENANT,
        name: 'tenant-tools',
        baseUrl: 'https://tools.tenant/mcp',
        enabled: true,
        toolAllowlist: ['lookup_code'],
      } as never),
      // Disabled rows never reach the worker, whichever tier owns them.
      McpServerFactory.CreateMcpServer({
        tenantId: TENANT,
        name: 'dormant',
        baseUrl: 'https://dormant.tenant/mcp',
        enabled: false,
      } as never),
    ]);

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.mcpServers.map((server) => server.name).sort()).toEqual(['fhir-terminology', 'tenant-tools']);
  });
});
