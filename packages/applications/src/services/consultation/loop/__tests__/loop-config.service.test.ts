/**
 * LoopConfigService.resolveForConsultation.
 *
 * Every resolution failure degrades to the disabled config rather than
 * throwing: missing/cross-tenant consultation, no department, no default
 * agent, no servable context schema. The compliance envelope
 * (`alwaysActions`/`neverActions`) and the `STREAM_AUDIO` start/ending
 * action derivation are covered directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { LoopConfigService, LOOP_CONFIG_MAX_DEPTH, LOOP_CONFIG_MAX_ACTIONS } from '../loop-config.service';
import { HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT, HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY } from '../loop-lifecycle.constants';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockConsultationRepository = { findById: vi.fn() };
// Added `findAllByDepartment` (the agent roster read). Defaulted to an
// empty roster in `beforeEach` so every pre-existing case keeps asserting the
// Shape: no roster means `reasoningEnabled: false` and `agents: []`.
const mockAgentRepository = { findDefaultForDepartment: vi.fn(), findAllByDepartment: vi.fn() };
const mockAgentVersionRepository = { findLatestForAgent: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };

function buildService(): LoopConfigService {
  return new LoopConfigService(
    mockConsultationRepository as never,
    mockAgentRepository as never,
    mockAgentVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
  );
}

const DEFAULT_BUDGET = { maxDepth: LOOP_CONFIG_MAX_DEPTH, maxActions: LOOP_CONFIG_MAX_ACTIONS };

/** A schema definition declaring one kind per fixture case, keyed by primitive. */
function definitionWithKind(kindKey: string, primitive: string) {
  return {
    schemaVersion: '1.0',
    kinds: [
      {
        key: kindKey,
        label: kindKey,
        primitive,
        phiClass: 'PHI',
        cardinality: 'MANY',
        lifecycle: 'DURING',
        producedBy: ['CLIENT'],
      },
    ],
  };
}

const SCHEMA_ROW = { id: 'schema-1', pinnedVersionNumber: 3, status: 'PUBLISHED' };

describe('LoopConfigService.resolveForConsultation', () => {
  let service: LoopConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentRepository.findAllByDepartment.mockResolvedValue([]);
    service = buildService();
  });

  it('degrades to a disabled config when the consultation is not found (cross-tenant id) — never throws', async () => {
    mockConsultationRepository.findById.mockRejectedValue(new DataNotFoundException('Consultation', 'consult-1'));

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result).toEqual({
      enabled: false,
      consultationId: null,
      departmentId: null,
      agentId: null,
      agentConfigVersionId: null,
      contextSchemaVersionId: null,
      subscriptions: [],
      budget: DEFAULT_BUDGET,
      startActions: [],
      endingActions: [],
      // A degraded config carries an EMPTY roster and the reasoning
      // lane OFF, so a consultation whose config could not be resolved keeps
      // behaving exactly as it did before the deliberative lane existed.
      reasoningEnabled: false,
      agents: [],
      // No bound on a disabled config: that branch completes
      // immediately and never reaches the wait the bound applies to.
      idleTimeoutSeconds: null,
      // …and therefore no endpoint stage on expiry either: a disabled loop can never expire.
      endpointOnTimeout: false,
    });
    expect(mockAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('degrades to a disabled config when the resolved consultation belongs to a different tenant', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'other-tenant', departmentId: 'dept-1' });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBeNull();
  });

  it('degrades to a disabled config (but still returns consultationId) when the consultation has no department', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: null });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBe('consult-1');
    expect(result.departmentId).toBeNull();
    expect(mockAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('degrades to a disabled config when the department has no default agent', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBe('consult-1');
    expect(result.departmentId).toBe('dept-1');
    expect(result.agentId).toBeNull();
  });

  it('populates agentConfigVersionId and contextSchemaVersionId and reports enabled:true when both resolve', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ id: 'agent-version-1' });
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(true);
    expect(result.agentId).toBe('agent-1');
    expect(result.agentConfigVersionId).toBe('agent-version-1');
    expect(result.contextSchemaVersionId).toBe('schema-version-1');
    // findDefaultForScope is tried DEPARTMENT-scoped first.
    expect(mockContextSchemaRepository.findDefaultForScope).toHaveBeenNthCalledWith(1, 'tenant-1', 'DEPARTMENT', 'dept-1');
  });

  it('a STREAM_AUDIO subscribed kind produces startActions [livedoc.start] and the full ordered endpoint stage', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.startActions).toEqual(['livedoc.start']);
    // TASK-812 (D-10): the ending half is no longer the literal `['livedoc.stop',
    // 'harness.finalize']`. With no `consultation.endpoint.actions` row configured it resolves to
    // the platform default sequence, in the platform's order — which still opens with
    // `livedoc.stop` and still finalizes, and now also stamps the disposition, locks every
    // document and captures feedback.
    expect(result.endingActions).toEqual(['livedoc.stop', 'session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']);
    // STREAM_AUDIO's own default action list is empty.
    expect(result.subscriptions).toEqual([{ kindKey: 'transcript', actions: [] }]);
  });

  it('a non-STREAM_AUDIO-only subscription set produces startActions [] and an endpoint stage without livedoc.stop', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('referral_letter', 'DOCUMENT'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.startActions).toEqual([]);
    // Audio scoping is the one rule carried over verbatim from `endingActionsBase`: a
    // consultation that never streamed audio has no live-documentation session to stop.
    expect(result.endingActions).toEqual(['session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']);
    expect(result.subscriptions).toEqual([{ kindKey: 'referral_letter', actions: ['document.extract_text', 'client.emit'] }]);
  });

  it('neverActions: [harness.finalize] removes harness.finalize from endingActions', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: null,
      neverActions: ['harness.finalize'],
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    // The veto still works — it is simply no longer the ONLY lever (D-10).
    expect(result.endingActions).toEqual(['livedoc.stop', 'session.timeout', 'summary.finalize', 'feedback.capture']);
  });

  it('alwaysActions EXTENDS the endpoint stage — the lever neverActions never had (D-10)', async () => {
    // An agent that names an endpoint-eligible action in `alwaysActions` gets it appended to the
    // stage. Before TASK-812 there was no way for an agent to ADD an endpoint step at all: the
    // sequence was a literal and `alwaysActions` only fed per-kind subscriptions.
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] },
      // `client.emit` is deliberately in the list too: it is NOT endpoint-eligible, so it must
      // not leak into the stage. That restriction is what keeps every pre-TASK-812 agent — which
      // almost always carries `client.emit` here — behaving exactly as it did.
      alwaysActions: ['client.emit'],
      neverActions: ['summary.finalize', 'feedback.capture', 'session.timeout'],
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('referral_letter', 'DOCUMENT'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.endingActions).toEqual(['harness.finalize']);
    expect(result.subscriptions).toEqual([{ kindKey: 'referral_letter', actions: ['document.extract_text', 'client.emit'] }]);
  });

  it('alwaysActions: [client.emit] appears on a kind whose primitive maps to [] (STREAM_AUDIO)', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: ['client.emit'],
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([{ kindKey: 'transcript', actions: ['client.emit'] }]);
  });

  it('a malformed subscribedKinds payload yields [] subscriptions rather than throwing', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: 'not-an-array' },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([]);
    expect(result.startActions).toEqual([]);
    // No resolvable kind ⇒ no STREAM_AUDIO ⇒ the audio-scoped step drops, and the rest of the
    // platform endpoint stage still runs. A consultation whose schema could not be resolved must
    // still finalize; that is the same degradation posture the rest of this resolver takes.
    expect(result.endingActions).toEqual(['session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']);
  });

  it('a null subscribedKinds payload yields [] subscriptions', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([]);
  });

  it('every schema tier missing a servable version reports enabled:false when the agent also has no version snapshot', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.agentId).toBe('agent-1');
    expect(result.contextSchemaVersionId).toBeNull();
  });
});

describe('LoopConfigService — agent roster', () => {
  let service: LoopConfigService;

  const PRIMARY = {
    id: 'agent-primary',
    slug: 'primary',
    role: 'PRIMARY',
    goal: { version: 1, objective: 'Produce one reconciled note' },
    subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }, { key: 'worknote' }] },
    writeScope: { version: 1, outputs: ['soap_note'] },
    alwaysActions: null,
    neverActions: null,
  };
  const SPECIALIST = {
    id: 'agent-cardio',
    slug: 'cardiology',
    role: 'SPECIALIST',
    goal: null,
    subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
    writeScope: { version: 1, outputs: ['cardiology_finding'] },
    alwaysActions: null,
    neverActions: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildService();
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(PRIMARY);
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ id: 'dav-1' });
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
  });

  it('resolves each agent read scope, write scope and pinned config version', async () => {
    mockAgentRepository.findAllByDepartment.mockResolvedValue([PRIMARY, SPECIALIST]);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.agents).toEqual([
      {
        agentId: 'agent-primary',
        role: 'PRIMARY',
        slug: 'primary',
        goal: 'Produce one reconciled note',
        subscribedKinds: ['transcript', 'worknote'],
        writeScope: ['soap_note'],
        agentConfigVersionId: 'dav-1',
      },
      {
        agentId: 'agent-cardio',
        role: 'SPECIALIST',
        slug: 'cardiology',
        goal: null,
        subscribedKinds: ['transcript'],
        writeScope: ['cardiology_finding'],
        agentConfigVersionId: 'dav-1',
      },
    ]);
  });

  it('enables reasoning ONLY when there is a primary AND at least one specialist', async () => {
    mockAgentRepository.findAllByDepartment.mockResolvedValue([PRIMARY, SPECIALIST]);
    expect((await service.resolveForConsultation('tenant-1', 'consult-1')).reasoningEnabled).toBe(true);
  });

  it('leaves reasoning OFF for a single-agent department (exactly the original behaviour)', async () => {
    mockAgentRepository.findAllByDepartment.mockResolvedValue([PRIMARY]);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.reasoningEnabled).toBe(false);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].role).toBe('PRIMARY');
  });

  it('falls back to the department DEFAULT agent as primary when no agent carries the PRIMARY role', async () => {
    // A department configured with a default but no roles. The
    // loop must still have exactly one note owner rather than none.
    const rolelessDefault = { ...PRIMARY, role: 'SPECIALIST' };
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(rolelessDefault);
    mockAgentRepository.findAllByDepartment.mockResolvedValue([rolelessDefault, SPECIALIST]);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    const primaries = result.agents.filter((a) => a.role === 'PRIMARY');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].agentId).toBe('agent-primary');
  });

  it('treats a structurally malformed writeScope as NOTHING granted, never everything', async () => {
    const broken = { ...SPECIALIST, writeScope: { version: 99, outputs: ['anything'] } };
    mockAgentRepository.findAllByDepartment.mockResolvedValue([PRIMARY, broken]);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.agents[1].writeScope).toEqual([]);
  });

  it('degrades a malformed goal envelope to null rather than leaking the object into a prompt', async () => {
    const broken = { ...SPECIALIST, goal: { version: 1, notObjective: 'x' } };
    mockAgentRepository.findAllByDepartment.mockResolvedValue([PRIMARY, broken]);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.agents[1].goal).toBeNull();
  });
});

/**
 * The loop's IDLE lifecycle bound.
 *
 * This resolution is the ONLY path the bound can reach the workflow by: the
 * harness pins the config at start and never re-reads it (C1), so a bound that
 * fails to resolve here is a loop that parks forever — the exact defect the
 * ticket fixes, reintroduced one layer up.
 */
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
      mockAgentRepository as never,
      mockAgentVersionRepository as never,
      mockContextSchemaRepository as never,
      mockContextSchemaVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      settings,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentRepository.findAllByDepartment.mockResolvedValue([]);
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({ id: 'agent-1', subscribedKinds: null, alwaysActions: null, neverActions: null });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ id: 'dav-1' });
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
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
