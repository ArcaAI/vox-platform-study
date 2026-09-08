/**
 * The loop's IDLE BOUND.
 *
 * This resolution is the ONLY path the bound can reach the workflow by: the
 * harness pins the config at start and never re-reads it (C1), so a bound that
 * fails to resolve here is a loop that parks forever — the exact defect
 * fixed, reintroduced one layer up.
 *
 * Extracted from `loop-config.service.test.ts` when rebuilt
 * `LoopConfigService` off `DepartmentAgent`. Everything else in that file
 * asserted agent-derived fields and moved to
 * `loop-config.node-source.task815.test.ts`; the idle bound is orthogonal to
 * where the config comes from, so it kept its own suite rather than being
 * rewritten into a source test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoopConfigService } from '../loop-config.service';
import { HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT, HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY } from '../loop-lifecycle.constants';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = { findById: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

describe('LoopConfigService.resolveForConsultation — idle bound', () => {
  /** The same fake platform cache the settings-registry suites use. */
  function settingsWith(value: unknown): TenantSettingsService {
    const store = new Map<string, unknown>(value === undefined ? [] : [[HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY, value]]);
    return new TenantSettingsService({
      getValueFromCache: (key: string) => (store.has(key) ? store.get(key) : null),
      getTenantValueFromCache: () => null,
    } as never);
  }

  function buildWithSettings(settings?: TenantSettingsService): LoopConfigService {
    return new LoopConfigService(
      mockConsultationRepository as never,
      mockContextSchemaRepository as never,
      mockContextSchemaVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      settings,
      mockWorkflowAssignments as never,
      mockWorkflowDefinitionRepository as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
    // A governing definition is enough to keep the config ENABLED, so these
    // cases exercise the bound rather than the disabled branch.
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'wfdef-1', slug: 'consultation-default', paletteKey: 'core' });
  });

  it('is a registered `global-kv` descriptor, not an env var', () => {
    // The tier argument, asserted rather than asserted-in-prose: a value an
    // operator must be able to change without a redeploy is not an env var
    // (env vars are immutable for the process lifetime), and it is below no
    // bootstrap floor.
    const descriptor = HOPE_SETTINGS_REGISTRY.get(HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.dataType).toBe('number');
    // A tuning knob: an absent row degrades to the code default, it never raises.
    expect(descriptor!.failMode).toBe('open-to-default');
    // NOT a kill-switch — it has a non-trivial default that "off" cannot express.
    expect(descriptor!.killSwitch).toBeUndefined();
    expect(descriptor!.default).toBe(HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT);
  });

  it('resolves the code default when no platform row exists — absence is a BOUNDED loop', async () => {
    const result = await buildWithSettings(settingsWith(undefined)).resolveForConsultation('tenant-1', 'consult-1');
    expect(result.idleTimeoutSeconds).toBe(HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT);
  });

  it('resolves the operator-set platform row', async () => {
    const result = await buildWithSettings(settingsWith(900)).resolveForConsultation('tenant-1', 'consult-1');
    expect(result.idleTimeoutSeconds).toBe(900);
  });

  it('falls back to the bounded default when the resolver is not wired at all', async () => {
    // `@Optional()`: an unwired resolver must not silently restore the unbounded
    // wait, which is the failure direction that matters here.
    const result = await buildWithSettings(undefined).resolveForConsultation('tenant-1', 'consult-1');
    expect(result.idleTimeoutSeconds).toBe(HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT);
  });

  it.each([0, -1, Number.NaN])('treats a non-positive stored value (%s) as "no bound", never as a zero-second one', async (value) => {
    const result = await buildWithSettings(settingsWith(value)).resolveForConsultation('tenant-1', 'consult-1');
    expect(result.idleTimeoutSeconds).toBeNull();
  });

  it('sends no bound on a DISABLED config — that branch never reaches the wait', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: null });

    const result = await buildWithSettings(settingsWith(900)).resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.idleTimeoutSeconds).toBeNull();
  });
});
