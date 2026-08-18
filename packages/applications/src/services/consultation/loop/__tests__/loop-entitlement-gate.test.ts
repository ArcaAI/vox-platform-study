/**
 * TASK-705 — the harness agentic loop is a SUBSCRIPTION FEATURE.
 *
 * The owner decision (`docs/architecture/agentic-workflow-platform/owner-decisions-2026-08-17.md`
 * §2 row 705) dissolves the old framing entirely: whether the loop runs for a
 * consultation is no longer an environment kill-switch, it is the tenant's
 * ENTITLEMENT. The operational device survives alongside it, with a different
 * job and the opposite polarity.
 *
 * THE COMPOSITION RULE THIS SUITE PINS
 *
 *     signals(tenant) ⇔ entitlement(tenant).agenticLoop === true
 *                       AND harness.loop.emergencyStop !== true
 *
 *   • The ENTITLEMENT is the only source of eligibility. It is commercial, it
 *     is per tenant, and it is resolved from the database.
 *   • The EMERGENCY STOP is a platform-wide operational VETO. It can only ever
 *     SUBTRACT — engaging it stops an entitled tenant, disengaging it never
 *     grants an unentitled one.
 *   • No tenant identity ⇒ DENY. Eligibility that cannot be established is not
 *     eligibility (and `X-Tenant-Id` is mandatory on tenant-scoped internal
 *     work — `00-project-context.md` §Tenant identity).
 *
 * Also pinned here: the platform lane never widens to a CUSTOMER tenant. The
 * emergency-stop key is `maxScope: 'system'`, so a row planted under a tenant
 * is ignored on READ and the platform row / descriptor default answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { HARNESS_LOOP_EMERGENCY_STOP_KEY } from '../../consultation-gates.constants';
import { LoopContextSignalService } from '../loop-context-signal.service';
import type { ContextAddedPayload } from '../../events';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

interface GateOptions {
  /** `undefined` leaves the platform row genuinely ABSENT (descriptor default answers). */
  emergencyStop?: boolean;
  /** What `isFeatureEnabled` resolves to. `undefined` ⇒ no entitlements service wired at all. */
  entitled?: boolean;
  /** A row planted under a CUSTOMER tenant — must never govern a `maxScope: 'system'` key. */
  tenantScopedEmergencyStop?: boolean;
  /** CLS-supplied tenant for the two lifecycle-boundary signal callers. */
  clsTenantId?: string | null;
}

function buildDeps(options: GateOptions = {}) {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const appSettings = {
    getValueFromCache: (key: string) =>
      key === HARNESS_LOOP_EMERGENCY_STOP_KEY && options.emergencyStop !== undefined ? options.emergencyStop : null,
    getTenantValueFromCache: (_tenantId: string, key: string) =>
      key === HARNESS_LOOP_EMERGENCY_STOP_KEY && options.tenantScopedEmergencyStop !== undefined ? options.tenantScopedEmergencyStop : null,
  };
  const tenantSettings = new TenantSettingsService(appSettings as never);
  const entitlements =
    options.entitled === undefined ? undefined : { isFeatureEnabled: vi.fn(async () => options.entitled as boolean) };
  const clsService = { get: (key: string) => (key === 'tenantId' ? (options.clsTenantId ?? null) : null) };

  const service = new LoopContextSignalService(
    harnessGatewayService as never,
    tenantSettings,
    entitlements as never,
    clsService as never,
  );
  return { service, harnessGatewayService, entitlements };
}

function payload(overrides: Partial<ContextAddedPayload> = {}): ContextAddedPayload {
  return {
    consultationId: 'consultation-1',
    tenantId: TENANT_A,
    timestamp: '2026-08-17T10:00:00.000Z',
    contextItemId: 'ctx-1',
    contextType: 'WORKNOTE',
    ...overrides,
  };
}

describe('TASK-705 — loop eligibility is the tenant entitlement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an ENTITLED tenant runs the loop', async () => {
    const { service, harnessGatewayService, entitlements } = buildDeps({ entitled: true });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    expect(entitlements!.isFeatureEnabled).toHaveBeenCalledWith(TENANT_A, 'agenticLoop');
  });

  it('an UNENTITLED tenant does not', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: false });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('resolves the entitlement for the PAYLOAD tenant, never a neighbour', async () => {
    const { service, entitlements } = buildDeps({ entitled: true });

    await service.handleContextAdded(payload({ tenantId: TENANT_B }));

    expect(entitlements!.isFeatureEnabled).toHaveBeenCalledWith(TENANT_B, 'agenticLoop');
    expect(entitlements!.isFeatureEnabled).not.toHaveBeenCalledWith(TENANT_A, 'agenticLoop');
  });

  it('DENIES when no tenant identity is available — eligibility that cannot be established is not eligibility', async () => {
    const { service, harnessGatewayService, entitlements } = buildDeps({ entitled: true });

    await service.handleContextAdded(payload({ tenantId: undefined as unknown as string }));

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
    expect(entitlements!.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('DENIES when no entitlements resolver is wired — a commercial gate fails CLOSED', async () => {
    const { service, harnessGatewayService } = buildDeps({});

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('DENIES when the entitlement read itself fails (never grants a paid feature on an infra error)', async () => {
    const { service, harnessGatewayService, entitlements } = buildDeps({ entitled: true });
    entitlements!.isFeatureEnabled.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(service.handleContextAdded(payload())).resolves.toBeUndefined();
    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });
});

describe('TASK-705 — the emergency stop is a veto, not an enabler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the EMERGENCY OVERRIDE still wins over an entitled tenant', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: true, emergencyStop: true });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('disengaging the stop never GRANTS an unentitled tenant', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: false, emergencyStop: false });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('an ABSENT stop row is "no emergency" — the descriptor default does not veto', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: true });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
  });

  it('short-circuits: an engaged stop never even resolves the entitlement', async () => {
    const { service, entitlements } = buildDeps({ entitled: true, emergencyStop: true });

    await service.handleContextAdded(payload());

    expect(entitlements!.isFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe('TASK-705 — the stop resolves platform → code-default, NEVER a customer tenant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores a stop row planted under a customer tenant (maxScope: system)', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: true, tenantScopedEmergencyStop: true });

    await service.handleContextAdded(payload());

    // The tenant lane is never consulted for this key, so the planted `true`
    // cannot veto — the platform lane (absent → descriptor default) answers.
    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
  });

  it('the PLATFORM row is what vetoes, even with a permissive tenant-scoped row present', async () => {
    const { service, harnessGatewayService } = buildDeps({
      entitled: true,
      emergencyStop: true,
      tenantScopedEmergencyStop: false,
    });

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });
});

describe('TASK-705 — the lifecycle-boundary signals share the composition rule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('signalConsultationEnding forwards for an entitled CLS tenant', async () => {
    const { service, harnessGatewayService, entitlements } = buildDeps({ entitled: true, clsTenantId: TENANT_A });

    await service.signalConsultationEnding('consultation-1', { reason: 'recording_stopped' });

    expect(entitlements!.isFeatureEnabled).toHaveBeenCalledWith(TENANT_A, 'agenticLoop');
    expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith('consultation-1', { reason: 'recording_stopped' });
  });

  it('signalConsultationEnding is a no-op for an unentitled tenant', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: false, clsTenantId: TENANT_A });

    await service.signalConsultationEnding('consultation-1', { reason: 'recording_stopped' });

    expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
  });

  it('signalLoopCancel is a no-op with no CLS tenant', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: true, clsTenantId: null });

    await service.signalLoopCancel('consultation-1', { reason: 'abandoned' });

    expect(harnessGatewayService.signalLoopCancel).not.toHaveBeenCalled();
  });

  it('signalLoopCancel is vetoed by the emergency stop', async () => {
    const { service, harnessGatewayService } = buildDeps({ entitled: true, emergencyStop: true, clsTenantId: TENANT_A });

    await service.signalLoopCancel('consultation-1', { reason: 'abandoned' });

    expect(harnessGatewayService.signalLoopCancel).not.toHaveBeenCalled();
  });
});
