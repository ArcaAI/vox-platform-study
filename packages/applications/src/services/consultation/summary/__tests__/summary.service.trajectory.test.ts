/**
 * SummaryService — trajectory emitter.
 *
 * Each generate / pre-summary emits ONE LLM_CALL trajectory step via the
 * (optional) AgentTrajectoryService: sessionKind=SUMMARY_JOB,
 * sessionId=the generated summary's contextItem id, runId="", seq=0, with the
 * AD-1 stats attached. Fire-and-forget: a trajectory failure never rolls back
 * the delivered summary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentSessionKind, AgentStepStatus, AgentStepType } from '@arcaai/domains';
import { SummaryService } from '../summary.service';
import type { CreateAgentTrajectoryStepInput } from '../../../agent-trajectory/dto';

const TENANT = 'tenant-1';
const CID = 'consultation-1';
const STATS = { stop_reason: 'length', ttft_ms: 210, tokens_per_second: 42.5, engine_native: null };

function buildService(trajectoryOverride?: { recordSteps: ReturnType<typeof vi.fn> }) {
  const clsService = {
    get: vi.fn().mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
  };
  const eventEmitter = { emit: vi.fn() };
  const contextItemRepository = {
    findById: vi.fn(),
    findCaseNotes: vi.fn().mockResolvedValue([{ id: 'cn-1', content: 'case note content' }]),
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
  };
  const consultationRepository = { findById: vi.fn().mockResolvedValue({ id: CID, tenantId: TENANT, departmentId: null, doctorId: null }), update: vi.fn() };
  const summaryMetaRepository = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), findByContextItem: vi.fn().mockResolvedValue(null) };
  const namedEntityRepository = { create: vi.fn() };
  const contextItemVersionRepository = { create: vi.fn().mockResolvedValue({ id: 'v-1' }), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm', processingTimeMs: 77, stats: STATS } }) } };
  const configService = { get: vi.fn().mockImplementation((k: string) => (k === 'SMR_URL' ? 'http://smr' : k === 'NLP_URL' ? 'http://nlp' : undefined)) };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'p', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
  };
  const harnessPolicyService = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) };
  const trajectory = trajectoryOverride ?? { recordSteps: vi.fn().mockResolvedValue(undefined) };

  const service = new SummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    summaryMetaRepository as never,
    namedEntityRepository as never,
    httpService as never,
    configService as never,
    eventEmitter as never,
    clsService as never,
    contextItemVersionRepository as never,
    promptAssemblyService as never,
    undefined as never, // secretsService
    undefined as never, // userProfileRepository
    undefined as never, // harnessAuditService
    undefined as never, // harnessGatewayService
    harnessPolicyService as never, // harnessPolicyService
    undefined as never, // configResolver
    undefined as never, // entitlements
    trajectory as never, // trajectory emitter
  );
  return { service, trajectory, contextItemRepository };
}

function recordedStep(trajectory: { recordSteps: ReturnType<typeof vi.fn> }): CreateAgentTrajectoryStepInput {
  const batch = trajectory.recordSteps.mock.calls[0][0] as CreateAgentTrajectoryStepInput[];
  expect(batch).toHaveLength(1);
  return batch[0];
}

describe('SummaryService — trajectory emitter (§2C)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits one SUMMARY_JOB LLM_CALL step on generateSummary', async () => {
    const { service, trajectory, contextItemRepository } = buildService();
    contextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });

    await service.generateSummary(CID, { dnaStyleId: 's' } as never);

    expect(trajectory.recordSteps).toHaveBeenCalledTimes(1);
    const step = recordedStep(trajectory);
    expect(step).toMatchObject({
      tenantId: TENANT,
      consultationId: CID,
      sessionKind: AgentSessionKind.SUMMARY_JOB,
      sessionId: 'ctx-new',
      runId: '',
      seq: 0,
      stepType: AgentStepType.LLM_CALL,
      name: 'generate',
      status: AgentStepStatus.OK,
    });
    expect(step.stats).toMatchObject({ stop_reason: 'length', ttft_ms: 210 });
  });

  it('emits one SUMMARY_JOB LLM_CALL step on generatePreSummary', async () => {
    const { service, trajectory, contextItemRepository } = buildService();
    contextItemRepository.create.mockResolvedValue({ id: 'ctx-pre', content: 'S', createdAt: new Date(), updatedAt: new Date() });

    await service.generatePreSummary(CID, {} as never);

    const step = recordedStep(trajectory);
    expect(step).toMatchObject({ sessionKind: AgentSessionKind.SUMMARY_JOB, sessionId: 'ctx-pre', name: 'pre-summary', runId: '', seq: 0 });
  });

  it('is fire-and-forget: a trajectory failure never rolls back the summary', async () => {
    const trajectory = { recordSteps: vi.fn().mockRejectedValue(new Error('trajectory down')) };
    const { service, contextItemRepository } = buildService(trajectory);
    contextItemRepository.create.mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() });

    const res = await service.generateSummary(CID, { dnaStyleId: 's' } as never);
    expect(res).toBeDefined();
    expect(trajectory.recordSteps).toHaveBeenCalled();
  });
});
