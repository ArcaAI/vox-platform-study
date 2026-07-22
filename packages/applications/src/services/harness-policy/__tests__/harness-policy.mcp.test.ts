/**
 * HarnessPolicyService — MCP policy plumbing.
 *
 * `mcpToolsEnabled` (harness.prisma) and the `McpServer` registry were both built,
 * and the Python side parsed both keys — but the TS policy response never emitted
 * either. `models.py` therefore always received `None`/`[]`, `workflows.py:417`
 * was permanently False, and the whole MCP tool path was unreachable regardless of
 * what a global admin configured.
 *
 * Three distinct breaks, all pinned here:
 *   1. `entityToKnobs` never read `e.mcpToolsEnabled` — so it was dropped from
 *      every response built from a policy row (the code-default path leaked it
 *      only because that one spreads HARNESS_POLICY_DEFAULTS wholesale).
 *   2. `getEffectivePolicy` never consulted the `McpServer` registry, so
 *      `mcpServers` did not exist on the wire at all.
 *   3. the knob was absent from `GLOBAL_ADMIN_ONLY_POLICY_KEYS`, so once added it
 *      would have been tenant-writable — MCP is global-admin governance.
 *
 * The flag stays default-OFF: `null ⇒ OFF` is asserted, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
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
const databaseService = {
  baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) },
};
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

const mcpServerEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'mcp-1',
  tenantId: SYSTEM_TENANT_ID,
  name: 'terminology',
  description: null,
  baseUrl: 'https://terminology.internal',
  transport: 'streamable-http',
  authRef: 'secret/data/mcp/terminology',
  toolAllowlist: ['lookup_code'],
  phiBoundary: 'internal',
  enabled: true,
  version: 1,
  ...overrides,
});

describe('HarnessPolicyService — MCP policy plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyRepository.findForExactTenant.mockResolvedValue(null);
    mcpServerRepository.findAll.mockResolvedValue([]);
  });

  describe('mcpToolsEnabled survives the round trip', () => {
    it('is serialized onto the effective policy from the SYSTEM row', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpToolsEnabled).toBe(true);
    });

    it('defaults to null (⇒ OFF in the workflow) when never configured', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy());

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpToolsEnabled ?? null).toBeNull();
    });

    it('comes from SYSTEM even when the tenant has its own policy row', async () => {
      // MCP is global-admin governance: a tenant row must not shadow it.
      policyRepository.findForExactTenant.mockResolvedValue(
        HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, mcpToolsEnabled: false } as never),
      );
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpToolsEnabled).toBe(true);
    });

    it('is rejected on a tenant patch (403 — global-admin only)', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy());

      await expect(
        makeService().updatePolicy({ mcpToolsEnabled: true } as never, 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is accepted on the global default patch', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: null }));

      const updated = await makeService(SYSTEM_TENANT_ID).updateGlobalDefault(
        { mcpToolsEnabled: true } as never,
        1,
      );

      expect(updated.mcpToolsEnabled).toBe(true);
    });
  });

  describe('mcpServers registry is serialized for the worker', () => {
    it('emits enabled SYSTEM-shared servers in the shape McpServerConfig.from_api parses', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));
      mcpServerRepository.findAll.mockResolvedValue([mcpServerEntity()]);

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpServers).toHaveLength(1);
      expect(effective.mcpServers![0]).toMatchObject({
        id: 'mcp-1',
        name: 'terminology',
        baseUrl: 'https://terminology.internal',
        transport: 'streamable-http',
        // A Vault PATH, never secret material — safe on the wire.
        authRef: 'secret/data/mcp/terminology',
        toolAllowlist: ['lookup_code'],
        phiBoundary: 'internal',
        enabled: true,
      });
    });

    it('omits disabled servers — McpServer.enabled is the second gate', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));
      mcpServerRepository.findAll.mockResolvedValue([
        mcpServerEntity({ id: 'mcp-on', name: 'on', enabled: true }),
        mcpServerEntity({ id: 'mcp-off', name: 'off', enabled: false }),
      ]);

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpServers!.map((s) => s.id)).toEqual(['mcp-on']);
    });

    it('is an empty list (never undefined) when the registry is empty', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy());

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpServers).toEqual([]);
    });

    it('degrades to an empty list when the registry read fails — never sinks the policy read', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ mcpToolsEnabled: true }));
      mcpServerRepository.findAll.mockRejectedValue(new Error('db down'));

      const effective = await makeService().getEffectivePolicy(TENANT);

      expect(effective.mcpServers).toEqual([]);
      expect(effective.mcpToolsEnabled).toBe(true);
    });

    it('is empty when the service has no registry wired (arity-preserving fixtures)', async () => {
      policyRepository.findSystemDefault.mockResolvedValue(systemPolicy());
      const service = new HarnessPolicyService(
        policyRepository as never,
        policyChangeRepository as never,
        databaseService as never,
        clsFor(TENANT) as never,
      );

      const effective = await service.getEffectivePolicy(TENANT);

      expect(effective.mcpServers).toEqual([]);
    });
  });
});
