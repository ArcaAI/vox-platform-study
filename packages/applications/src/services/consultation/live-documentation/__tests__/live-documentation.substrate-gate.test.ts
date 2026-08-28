/**
 * TASK-811 task 13 — THE SUBSTRATE GATE, and tasks 3/15 — graph mode + parity.
 *
 * ## The defect
 *
 * `startRecording` called `liveDocumentationService.start()` after only an
 * ownership and a status check, so the hardcoded flush ran for EVERY recording
 * session regardless of what the tenant had authored. That is the root cause
 * TASK-806 §2.1 names, and it is the reason this whole programme exists.
 *
 * ## The parity claim
 *
 * `PLATFORM_REALTIME_LANE` encodes today's behaviour as a graph. Running the same
 * transcript through the legacy engine and the graph executor must therefore
 * produce the SAME trajectory — that is the cutover evidence, and it is asserted
 * here by diffing the recorded step sequences.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { GOVERNING_ENGINE_METADATA_KEY, TENANT_WORKFLOW_GOVERNS_MARKER } from '../../governing-engine';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot, type ILiveAgentResolver } from '../live-agent.port';

const CID = 'consultation-gate-001';
const TENANT = 'tenant-gate-001';
const NOTE = 'Subjective: patient reports cough and takes aspirin\nObjective:\nAssessment:\nPlan:';

const nerAiTaskDefaultDouble = () => ({ getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) });
const nerClsDouble = () => ({ run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() });

function httpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) {
      return Promise.resolve({
        data: {
          entities: [{ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 0, end: 7 } }],
          vitals: { systolic: 120, diastolic: 80 },
        },
      });
    }
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE } });
    return Promise.resolve({ data: {} });
  });
  return { post, http: { axiosRef: { post } } };
}

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  liveLlm: null,
  frozenAt: '2026-08-28T00:00:00.000Z',
});

interface BuildOpts {
  /** `Consultation.metadata` the substrate gate reads. */
  consultationMetadata?: unknown;
  /** Whether `consultationRepository.findById` throws. */
  consultationReadThrows?: boolean;
  /** Per-tenant graph-executor flag. */
  graphEnabled?: boolean;
  trajectory?: { recordSteps: ReturnType<typeof vi.fn> };
}

function buildService(http: unknown, opts: BuildOpts = {}) {
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };

  const consultationRepository = {
    findById: vi.fn(async () => {
      if (opts.consultationReadThrows) throw new Error('db down');
      return { id: CID, metadata: opts.consultationMetadata ?? null };
    }),
  };

  const effectiveSettings =
    opts.graphEnabled === undefined
      ? undefined
      : {
          resolveEffective: vi.fn(async (key: string) =>
            key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
              ? { value: opts.graphEnabled, sourceScope: 'tenant' }
              : { value: undefined, sourceScope: 'code-default' },
          ),
        };

  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    (opts.trajectory ?? undefined) as never,
    effectiveSettings as never,
    nerAiTaskDefaultDouble() as never,
    nerClsDouble() as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never as Partial<ILiveAgentResolver> as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    consultationRepository as never,
  );

  return { service, consultationRepository };
}

async function flushOnce(service: LiveDocumentationService, text = 'patient reports cough and takes aspirin') {
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text, isFinal: true, segmentId: 's1' });
  return service.flush(CID);
}

const governedMetadata = {
  [GOVERNING_ENGINE_METADATA_KEY]: {
    engine: TENANT_WORKFLOW_GOVERNS_MARKER,
    workflowRunId: 'run-1',
    workflowDefinitionSlug: 'tenant-soap',
    decidedAt: '2026-08-28T00:00:00.000Z',
  },
};

// ---------------------------------------------------------------------------
// Task 13 — the substrate gate
// ---------------------------------------------------------------------------

describe('task 13 — start() is gated on the governing substrate', () => {
  it('THE ROOT CAUSE: a consultation governed by a tenant workflow publishes NOTHING from this engine', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, { consultationMetadata: governedMetadata });

    const payload = await flushOnce(service);

    expect(payload).toBeNull();
    // Decisively: no TEXT call, no NLP call. The hardcoded loop did not run.
    expect(post).not.toHaveBeenCalled();
  });

  it('tears the session down so a governed consultation leaves no timers or locks behind', async () => {
    const { http } = httpMock();
    const { service } = buildService(http, { consultationMetadata: governedMetadata });

    service.start({ consultationId: CID, tenantId: TENANT });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.isActive(CID)).toBe(false);
  });

  it('an UNGOVERNED consultation is documented exactly as before', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, { consultationMetadata: null });

    const payload = await flushOnce(service);

    expect(payload?.runningSummary).toContain('patient reports cough');
    expect(post.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/generate'))).toBe(true);
  });

  it('FAILS OPEN: an unreadable marker keeps this engine, because no documentation is worse than default documentation', async () => {
    const { http } = httpMock();
    const { service } = buildService(http, { consultationReadThrows: true });

    const payload = await flushOnce(service);

    expect(payload).not.toBeNull();
  });

  it('FAILS OPEN: a MALFORMED marker reads as absent — only a well-formed one stands the engine down', async () => {
    const { http } = httpMock();
    const { service } = buildService(http, {
      consultationMetadata: { [GOVERNING_ENGINE_METADATA_KEY]: { engine: TENANT_WORKFLOW_GOVERNS_MARKER, workflowRunId: '' } },
    });

    await expect(flushOnce(service)).resolves.not.toBeNull();
  });

  it('resolves the marker ONCE per session, not once per flush', async () => {
    const { http } = httpMock();
    const { service, consultationRepository } = buildService(http, { consultationMetadata: null });

    service.start({ consultationId: CID, tenantId: TENANT });
    await new Promise((resolve) => setImmediate(resolve));
    service.ingestSegment(CID, { text: 'one', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'two', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    expect(consultationRepository.findById).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The per-tenant rollout flag
// ---------------------------------------------------------------------------

describe('the graph executor is behind a PER-TENANT flag, defaulting OFF', () => {
  it('with no settings facade wired the LEGACY path runs (today’s behaviour, unchanged)', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, {});

    const payload = await flushOnce(service);

    expect(payload?.runningSummary).toContain('patient reports cough');
    expect(post.mock.calls.filter((c) => String(c[0]).includes('/generate'))).toHaveLength(1);
  });

  it('with the flag OFF for this tenant the LEGACY path runs', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, { graphEnabled: false });

    await flushOnce(service);

    expect(post.mock.calls.filter((c) => String(c[0]).includes('/generate'))).toHaveLength(1);
  });

  it('with the flag ON the GRAPH executor runs — and produces the same note', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, { graphEnabled: true });

    const payload = await flushOnce(service);

    expect(payload?.runningSummary).toContain('patient reports cough');
    expect(payload?.entities.map((e) => e.text)).toEqual(['aspirin']);
    expect(payload?.vitals).toEqual({ systolic: 120, diastolic: 80 });
    // Still exactly one TEXT call and one NLP call — the graph did not double up.
    expect(post.mock.calls.filter((c) => String(c[0]).includes('/generate'))).toHaveLength(1);
    expect(post.mock.calls.filter((c) => String(c[0]).includes('/classify/tokens'))).toHaveLength(1);
  });

  it('GRAPH MODE never sends the generated note to NER — the invariant survives the engine swap', async () => {
    const { http, post } = httpMock();
    const { service } = buildService(http, { graphEnabled: true });

    await flushOnce(service);

    const nlpCall = post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'));
    expect(nlpCall?.[1]).toMatchObject({ text: 'patient reports cough and takes aspirin' });
    expect(JSON.stringify(nlpCall?.[1])).not.toContain('Subjective');
  });
});

// ---------------------------------------------------------------------------
// Task 15 — TRAJECTORY PARITY, the cutover evidence
// ---------------------------------------------------------------------------

describe('task 15 — trajectory parity between the legacy and graph engines', () => {
  /** The comparable shape of a recorded trajectory: WHICH steps, in WHICH order. */
  const shapeOf = (recordSteps: ReturnType<typeof vi.fn>) =>
    (recordSteps.mock.calls[0]?.[0] ?? []).map((step: { stepType: string; name: string; status: string; seq: number }) => ({
      seq: step.seq,
      stepType: step.stepType,
      name: step.name,
      status: step.status,
    }));

  it('the SAME transcript produces the SAME trajectory through both engines', async () => {
    const legacyTrajectory = { recordSteps: vi.fn().mockResolvedValue(undefined) };
    const graphTrajectory = { recordSteps: vi.fn().mockResolvedValue(undefined) };

    const legacy = buildService(httpMock().http, { graphEnabled: false, trajectory: legacyTrajectory });
    const graph = buildService(httpMock().http, { graphEnabled: true, trajectory: graphTrajectory });

    await flushOnce(legacy.service);
    await flushOnce(graph.service);

    const legacySteps = shapeOf(legacyTrajectory.recordSteps);
    const graphSteps = shapeOf(graphTrajectory.recordSteps);

    // The parity diff. If this ever fails, the two engines are producing
    // materially different runs and the cutover is not safe.
    expect(graphSteps).toEqual(legacySteps);
    expect(legacySteps).toEqual([
      { seq: 0, stepType: 'LLM_CALL', name: 'flush', status: 'OK' },
      { seq: 1, stepType: 'TOOL_CALL', name: 'nlp.classify-tokens', status: 'OK' },
      { seq: 2, stepType: 'PHASE', name: 'publish', status: 'OK' },
    ]);
  });

  it('the published PAYLOAD is equivalent across the two engines', async () => {
    const legacy = buildService(httpMock().http, { graphEnabled: false });
    const graph = buildService(httpMock().http, { graphEnabled: true });

    const legacyPayload = await flushOnce(legacy.service);
    const graphPayload = await flushOnce(graph.service);

    const comparable = (p: NonNullable<Awaited<ReturnType<LiveDocumentationService['flush']>>>) => ({
      runningSummary: p.runningSummary,
      sections: p.sections,
      entities: p.entities,
      vitals: p.vitals,
      textFailed: p.textFailed,
    });

    expect(comparable(graphPayload!)).toEqual(comparable(legacyPayload!));
  });
});
