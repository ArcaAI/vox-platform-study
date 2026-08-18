/**
 * LiveDocumentationService — trajectory emitter.
 *
 * Per flush the service must emit an ORDERED trajectory via the (optional)
 * AgentTrajectoryService:
 *   [LLM_CALL:flush, TOOL_CALL:nlp.classify-tokens (when NLP ran),
 *    GUARDRAIL:groundedness (when the gate ran), PHASE:publish].
 * sessionKind=LIVE_DOC, sessionId=the live session id, runId="", consultationId
 * set, seq monotonic within the session. Fire-and-forget: a trajectory failure
 * must NEVER break the flush.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentSessionKind, AgentStepStatus, AgentStepType } from '@arcaai/domains';
import { LiveDocumentationService } from '../live-documentation.service';
import type { CreateAgentTrajectoryStepInput } from '../../../agent-trajectory/dto';

const CID = 'consultation-tj-1';
const TENANT = 'tenant-tj';
const STT_SESSION = 'stt-session-9';

const STATS = { stop_reason: 'stop', ttft_ms: 12, tokens_per_second: 30 };

function buildHttpMock(opts: { grounded?: boolean } = {}) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string) => {
        if (url.includes('/classify/tokens')) {
          return Promise.resolve({ data: { entities: [{ entity_type: 'MEDICATION', text: 'amlodipine', position: { start: 6, end: 16 } }] } });
        }
        if (url.includes('/guardrail/ground')) {
          return Promise.resolve({ data: { checked: true, segments: [{ text: 'Pt on amlodipine.', verdict: 'grounded' }], flagged_spans: [] } });
        }
        if (url.includes('/generate')) {
          return Promise.resolve({ data: { summary: 'Pt on amlodipine.', stats: STATS } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

function buildService(opts: { config?: Record<string, unknown>; trajectory?: unknown; http?: ReturnType<typeof buildHttpMock> } = {}) {
  const cacheService = {
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
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const audioBridge = {
    subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }),
    unsubscribeFromResults: vi.fn(),
  };
  const config = opts.config ?? {};
  const configService = { get: vi.fn().mockImplementation((key: string) => config[key]) };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'live-medgemma' }) };
  const trajectory = opts.trajectory ?? { recordSteps: vi.fn().mockResolvedValue(undefined) };
  const http = opts.http ?? buildHttpMock();

  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    audioBridge as never,
    undefined as never, // contextItemRepository
    harnessPolicyService as never,
    undefined as never, // secretsService
    trajectory as never, // trajectory emitter
  );
  return { service, trajectory, http };
}

function recordedSteps(trajectory: { recordSteps: ReturnType<typeof vi.fn> }): CreateAgentTrajectoryStepInput[] {
  return trajectory.recordSteps.mock.calls[0][0] as CreateAgentTrajectoryStepInput[];
}

describe('LiveDocumentationService — trajectory emitter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits ordered [LLM_CALL, TOOL_CALL, PHASE] steps per flush (groundedness off)', async () => {
    const { service, trajectory } = buildService();
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    service.ingestSegment(CID, { text: 'Patient on amlodipine.', isFinal: true, segmentId: 's1' });

    await service.flush(CID, { force: true });

    expect(trajectory.recordSteps).toHaveBeenCalledTimes(1);
    const steps = recordedSteps(trajectory);
    expect(steps.map((s) => `${s.stepType}:${s.name}`)).toEqual([
      `${AgentStepType.LLM_CALL}:flush`,
      `${AgentStepType.TOOL_CALL}:nlp.classify-tokens`,
      `${AgentStepType.PHASE}:publish`,
    ]);
    // Session identity + monotonic seq.
    expect(steps.map((s) => s.seq)).toEqual([0, 1, 2]);
    for (const s of steps) {
      expect(s.sessionKind).toBe(AgentSessionKind.LIVE_DOC);
      expect(s.sessionId).toBe(STT_SESSION);
      expect(s.runId).toBe('');
      expect(s.consultationId).toBe(CID);
      expect(s.tenantId).toBe(TENANT);
    }
    // AD-1 stats ride on the LLM_CALL step.
    expect(steps[0].status).toBe(AgentStepStatus.OK);
    expect(steps[0].stats).toMatchObject({ stop_reason: 'stop', ttft_ms: 12 });
  });

  it('inserts the GUARDRAIL:groundedness step when the gate is enabled', async () => {
    const { service, trajectory } = buildService({ config: { LIVE_DOC_GROUNDEDNESS_ENABLED: 'true' } });
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    service.ingestSegment(CID, { text: 'Patient on amlodipine.', isFinal: true, segmentId: 's1' });

    await service.flush(CID, { force: true });

    const steps = recordedSteps(trajectory);
    expect(steps.map((s) => `${s.stepType}:${s.name}`)).toEqual([
      `${AgentStepType.LLM_CALL}:flush`,
      `${AgentStepType.TOOL_CALL}:nlp.classify-tokens`,
      `${AgentStepType.GUARDRAIL}:groundedness`,
      `${AgentStepType.PHASE}:publish`,
    ]);
    expect(steps.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
  });

  it('is fire-and-forget: a trajectory failure never breaks the flush', async () => {
    const trajectory = { recordSteps: vi.fn().mockRejectedValue(new Error('trajectory down')) };
    const { service } = buildService({ trajectory });
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    service.ingestSegment(CID, { text: 'Patient on amlodipine.', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID, { force: true });
    expect(payload).not.toBeNull();
    expect(payload?.runningSummary).toContain('amlodipine');
  });

  it('S1: no-STT sessions use a per-instance sessionId (not the bare consultationId) so restart never collides', async () => {
    const nowSpy = vi.spyOn(Date, 'now');

    // First session instance — no STT session attached, started at t=1000. A
    // fresh service instance models a stop→restart (or a different worker).
    nowSpy.mockReturnValue(1_000);
    const first = buildService();
    first.service.start({ consultationId: CID, tenantId: TENANT });
    first.service.ingestSegment(CID, { text: 'Patient on amlodipine.', isFinal: true, segmentId: 's1' });
    await first.service.flush(CID, { force: true });
    const firstSessionId = recordedSteps(first.trajectory)[0].sessionId;
    // Must NOT be the stable bare consultationId — that is exactly the key that
    // collides on restart and makes skipDuplicates silently drop the steps.
    expect(firstSessionId).not.toBe(CID);
    expect(firstSessionId.startsWith(`${CID}:`)).toBe(true);

    // Restart at a later instant → a distinct trajectory sessionId, so the
    // composite (tenantId, sessionId, runId, seq) key can't collide.
    nowSpy.mockReturnValue(2_000);
    const second = buildService();
    second.service.start({ consultationId: CID, tenantId: TENANT });
    second.service.ingestSegment(CID, { text: 'Now on lisinopril.', isFinal: true, segmentId: 's2' });
    await second.service.flush(CID, { force: true });
    const secondSessionId = recordedSteps(second.trajectory)[0].sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
  });
});
