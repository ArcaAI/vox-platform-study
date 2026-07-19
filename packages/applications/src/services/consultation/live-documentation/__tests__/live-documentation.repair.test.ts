/**
 * LiveDocumentationService — bounded JSON auto-repair (TASK-515 Phase 4D.3).
 *
 * When structured SOAP output (`response_format: json_schema`) comes back as
 * malformed JSON, the flush must do EXACTLY ONE corrective retry (appending the
 * seeded CORRECTIVE_RETRY instruction) and then fall back to the tolerant parser.
 * Both SMR calls must be recorded as ordered LLM_CALL trajectory steps.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentStepType } from '@arcaai/domains';
import { LiveDocumentationService } from '../live-documentation.service';
import type { CreateAgentTrajectoryStepInput } from '../../../agent-trajectory/dto';

const CID = 'consultation-repair-1';
const TENANT = 'tenant-repair';
const STT_SESSION = 'stt-session-repair';

const VALID_SOAP = JSON.stringify({
  subjective: 'Chest tightness on exertion.',
  objective: 'BP 150/95.',
  assessment: 'Hypertension.',
  plan: 'Start amlodipine 5mg daily.',
});

/** First `/generate` returns malformed JSON, the second returns valid SOAP JSON. */
function buildRepairHttpMock() {
  let generateCalls = 0;
  const post = vi.fn().mockImplementation((url: string, body?: unknown) => {
    if (url.includes('/classify/tokens')) {
      return Promise.resolve({ data: { entities: [{ entity_type: 'MEDICATION', text: 'amlodipine', position: { start: 0, end: 10 } }] } });
    }
    if (url.includes('/generate')) {
      generateCalls += 1;
      if (generateCalls === 1) {
        // Truncated / invalid JSON — parseSoapJson returns null → triggers repair.
        return Promise.resolve({ data: { summary: '{"subjective": "Chest tightness", "objective":' } });
      }
      return Promise.resolve({ data: { summary: VALID_SOAP } });
    }
    return Promise.resolve({ data: {} });
  });
  return { axiosRef: { post }, get generateCalls() { return generateCalls; } };
}

function buildService(http: ReturnType<typeof buildRepairHttpMock>) {
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
  const audioBridge = { subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }), unsubscribeFromResults: vi.fn() };
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const harnessPolicyService = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'live-medgemma' }) };
  const trajectory = { recordSteps: vi.fn().mockResolvedValue(undefined) };

  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    audioBridge as never,
    undefined as never,
    harnessPolicyService as never,
    undefined as never,
    trajectory as never,
  );
  return { service, trajectory };
}

function recordedSteps(trajectory: { recordSteps: ReturnType<typeof vi.fn> }): CreateAgentTrajectoryStepInput[] {
  return trajectory.recordSteps.mock.calls[0][0] as CreateAgentTrajectoryStepInput[];
}

describe('LiveDocumentationService — bounded JSON auto-repair (Phase 4D.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('repairs invalid JSON with EXACTLY ONE corrective retry and records both LLM_CALL steps', async () => {
    const http = buildRepairHttpMock();
    const { service, trajectory } = buildService(http);
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    service.ingestSegment(CID, { text: 'Chest tightness on exertion, BP high.', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID, { force: true });

    // Exactly one retry: the SMR /generate endpoint was hit exactly twice.
    expect(http.generateCalls).toBe(2);

    // The repaired (valid) SOAP JSON drives the running summary.
    expect(payload?.runningSummary).toContain('amlodipine');

    // The corrective retry appended the seeded CORRECTIVE_RETRY instruction.
    const generateBodies = http.axiosRef.post.mock.calls
      .filter((c) => String(c[0]).includes('/generate'))
      .map((c) => c[1] as { prompt: string });
    expect(generateBodies[0].prompt).not.toContain('REVISE STRICTLY');
    expect(generateBodies[1].prompt).toContain('REVISE STRICTLY');

    // Both the original and the repair SMR calls are recorded as ordered LLM_CALL steps.
    const steps = recordedSteps(trajectory);
    const llmSteps = steps.filter((s) => s.stepType === AgentStepType.LLM_CALL);
    expect(llmSteps.map((s) => s.name)).toEqual(['flush', 'flush.repair']);
    // The repair step follows the original immediately (monotonic seq).
    expect(llmSteps[1].seq).toBe(llmSteps[0].seq + 1);
  });

  it('does not retry when the first structured response is already valid JSON', async () => {
    const http = buildRepairHttpMock();
    // Force the first response to be valid so no repair is needed.
    http.axiosRef.post.mockImplementation((url: string) => {
      if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
      if (url.includes('/generate')) return Promise.resolve({ data: { summary: VALID_SOAP } });
      return Promise.resolve({ data: {} });
    });
    const { service, trajectory } = buildService(http);
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    service.ingestSegment(CID, { text: 'Chest tightness.', isFinal: true, segmentId: 's1' });

    await service.flush(CID, { force: true });

    const generateCount = http.axiosRef.post.mock.calls.filter((c) => String(c[0]).includes('/generate')).length;
    expect(generateCount).toBe(1);
    const steps = recordedSteps(trajectory);
    expect(steps.filter((s) => s.stepType === AgentStepType.LLM_CALL).map((s) => s.name)).toEqual(['flush']);
  });
});
