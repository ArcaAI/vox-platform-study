/**
 * TASK-1001 wave 6 (owner 2026-09-23) — the consultation COMPLETION TIMEOUT is a setting.
 *
 * "It must be in the settings, where a tenant admin can see all tenant settings and where the platform
 * admin can see the platform and default settings for tenants to fall back." So the value lives in
 * the settings registry (`consultation.session.completionTimeoutMinutes`, tenant → SYSTEM → code
 * default 5) and the harness keeps fetching ONE document: the effective harness policy derives the
 * clinician gate from it — `gateSlaSeconds = minutes × 60`, `gateMaxEscalations = 1` (the first
 * breach closes the session unsigned) — on every return path, like `tokenBudgetPerRun`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';
import {
  CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT,
  CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_COMPLETION_TIMEOUT_SETTINGS,
} from '../../settings-registry/descriptors/consultation-completion.descriptors';
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

const timeout = (minutes: unknown) =>
  effectiveSettings.resolveEffective.mockImplementation(async (key: string) =>
    key === CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY
      ? { value: minutes, sourceScope: 'tenant' }
      : { value: undefined, sourceScope: 'code-default' },
  );

beforeEach(() => {
  vi.clearAllMocks();
  policyRepository.findForExactTenant.mockResolvedValue(null);
  policyRepository.findSystemDefault.mockResolvedValue(null);
  mcpServerRepository.findAll.mockResolvedValue([]);
  timeout(5);
});

describe('TASK-1001 wave 6 — the clinician gate is derived from the completion-timeout setting', () => {
  it.each([
    ['a tenant row', () => policyRepository.findForExactTenant.mockResolvedValue(tenantPolicy({ gateSlaSeconds: 86400 }))],
    ['only the SYSTEM row', () => policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }))],
    ['no row at all (code defaults)', () => undefined],
  ])('with %s: gate SLA = minutes × 60 and the first breach is terminal', async (_label, arrange) => {
    arrange();
    timeout(7);

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(420);
    expect(effective.gateMaxEscalations).toBe(1);
    expect(effectiveSettings.resolveEffective).toHaveBeenCalledWith(CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY, { tenantId: TENANT });
  });

  it('a settings-backend failure falls to the platform code default (5 min), never to the 24 h row value', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }));
    effectiveSettings.resolveEffective.mockRejectedValue(new Error('settings down'));

    const effective = await makeService().getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(300);
    expect(effective.gateMaxEscalations).toBe(1);
  });

  it('an unusable stored value (0, fraction, text) also falls to the code default', async () => {
    for (const bad of [0, 1.5, 'soon', null]) {
      timeout(bad);
      const effective = await makeService().getEffectivePolicy(TENANT);
      expect(effective.gateSlaSeconds).toBe(300);
    }
  });

  it('without a settings graph (positional fixtures) the policy row is served unchanged', async () => {
    policyRepository.findSystemDefault.mockResolvedValue(systemPolicy({ gateSlaSeconds: 86400 }));

    const effective = await makeService(TENANT, null).getEffectivePolicy(TENANT);

    expect(effective.gateSlaSeconds).toBe(86400);
    expect(effective.gateMaxEscalations).toBeNull();
  });
});

describe('the descriptor', () => {
  const [descriptor] = CONSULTATION_COMPLETION_TIMEOUT_SETTINGS;

  it('is tenant-editable with a platform default of 5 minutes', () => {
    expect(descriptor).toMatchObject({
      key: 'consultation.session.completionTimeoutMinutes',
      maxScope: 'tenant',
      editableBy: 'GlobalSetting',
      dataType: 'number',
      default: 5,
    });
    expect(descriptor.globalOnly).toBeFalsy();
  });

  it('accepts whole minutes from 1 to 7 days and refuses everything else', () => {
    expect(descriptor.validate?.(1)).toBeUndefined();
    expect(descriptor.validate?.(5)).toBeUndefined();
    expect(descriptor.validate?.(10080)).toBeUndefined();
    for (const bad of [0, -1, 1.5, 10081, '5', null]) expect(descriptor.validate?.(bad)).toEqual(expect.any(String));
  });
});

/**
 * TASK-1003 OD-7 (owner, 2026-09-24): "make sure timeout is set to 5m". Verified live that no
 * override row exists in any tenant, so the descriptor default is what every tenant runs on. This
 * pins that default through the REAL cascade (no stubbed resolver): no tenant row, no platform row
 * ⇒ 5 minutes ⇒ a 300 s clinician gate.
 */
describe('TASK-1003 OD-7 — with no override row anywhere the completion timeout is 5 minutes', () => {
  it('the platform code default is 5', () => {
    expect(CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT).toBe(5);
  });

  it('the real tenant → platform → default cascade answers 5, and the gate SLA derived from it is 300 s', async () => {
    const noRows = { getValueFromCache: vi.fn(() => null), getTenantValueFromCache: vi.fn(() => null) };
    const cascade = new EffectiveSettingsService(new TenantSettingsService(noRows as never));

    await expect(cascade.resolveEffective(CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY, { tenantId: TENANT })).resolves.toMatchObject({
      value: 5,
      sourceScope: 'code-default',
    });

    const effective = await makeService(TENANT, cascade).getEffectivePolicy(TENANT);
    expect(effective.gateSlaSeconds).toBe(300);
    expect(effective.gateMaxEscalations).toBe(1);
  });
});
