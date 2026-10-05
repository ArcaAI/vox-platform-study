/**
 * The clinician gate SLA is derived from the consultation auto-close policy
 * (`consultation.autoClose.idleMinutes`, tenant -> SYSTEM -> 720): the effective harness policy
 * serves `gateSlaSeconds = idleMinutes x 60` and `gateMaxEscalations = 1` on every return path, and
 * the harness keeps fetching ONE document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';
import { CONSULTATION_AUTO_CLOSE_KEY } from '../../settings-registry/descriptors/consultation-lifecycle.descriptors';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';

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

const effectiveSettings = { resolveEffective: vi.fn() };

function makeService(tenantId = TENANT, settings: unknown = effectiveSettings): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    clsFor(tenantId) as never,
    undefined,
    undefined,
    mcpServerRepository as never,
    settings as never,
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

const policy = (idleMinutes: unknown, mode: unknown = 'idle') => ({ mode, idleMinutes, dailyAt: mode === 'daily' ? '23:00' : null });
const timeout = (value: unknown) =>
  effectiveSettings.resolveEffective.mockImplementation(async (key: string) =>
    key === CONSULTATION_AUTO_CLOSE_KEY ? { value, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
  );

beforeEach(() => {
  vi.clearAllMocks();
  policyRepository.findForExactTenant.mockResolvedValue(null);
  policyRepository.findSystemDefault.mockResolvedValue(null);
  mcpServerRepository.findAll.mockResolvedValue([]);
  timeout(policy(720));
});

describe('the clinician gate is derived from the auto-close policy', () => {
  it.each([
    ['a tenant row', () => policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ gateSlaSeconds: 86400 }))],
    ['only the SYSTEM row', () => policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }))],
    ['no row at all (code defaults)', () => undefined],
  ])('with %s: gate SLA = idleMinutes x 60 and one escalation', async (_label, arrange) => {
    arrange();
    timeout(policy(90));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(5400);
    expect(effective.gateMaxEscalations).toBe(1);
    expect(effectiveSettings.resolveEffective).toHaveBeenCalledWith(CONSULTATION_AUTO_CLOSE_KEY, { tenantId: TENANT });
  });

  it('daily mode still derives from idleMinutes', async () => {
    timeout(policy(120, 'daily'));
    expect((await makeService().getEffectivePolicy(TENANT)).gateSlaSeconds).toBe(7200);
  });

  it('a settings-backend failure falls to the platform default (720 min), never to the 24 h row value', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }));
    effectiveSettings.resolveEffective.mockRejectedValue(new Error('settings down'));

    expect((await makeService().getEffectivePolicy(TENANT)).gateSlaSeconds).toBe(43200);
  });

  it('an unusable stored value also falls to the default', async () => {
    for (const bad of [policy(0), policy(1.5), 'soon', null]) {
      timeout(bad);
      expect((await makeService().getEffectivePolicy(TENANT)).gateSlaSeconds).toBe(43200);
    }
  });

  it('without a settings graph (positional fixtures) the policy row is served unchanged', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }));

    const effective = await makeService(TENANT, null).getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(86400);
    expect(effective.gateMaxEscalations).toBeNull();
  });

  it('the real tenant -> platform -> default cascade serves 12 h', async () => {
    const noRows = { getValueFromCache: vi.fn(() => null), getTenantValueFromCache: vi.fn(() => null) };
    const cascade = new EffectiveSettingsService(new TenantSettingsService(noRows as never));

    const effective = await makeService(TENANT, cascade).getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(43200);
    expect(effective.gateMaxEscalations).toBe(1);
  });
});
