/**
 * TASK-1002 — the gateway passes `consultationId` into ASR agent resolution (`POST
 * .../stream/session` and `POST .../transcribe`), so `AsrAgentResolverService` can apply the
 * consultation's governing-workflow tier ahead of the department/tenant assignment cascade.
 *
 * This lane (L-C) does not implement the resolver's precedence itself (lane L-B does, in
 * `AsrAgentResolverService.resolve`) — it wires the gateway to the contract: `consultationId` is
 * forwarded on every consultation-bound entry point, the stream-session response echoes which
 * tier won (`agentSource`), the gateway logs one `stt.asr_agent_resolved` line per session so an
 * operator can answer "which tier won" without reading Redis, and a `WORKFLOW_ASR_AGENT_UNAVAILABLE`
 * 409 from the resolver propagates unchanged.
 */
import { ConflictException, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'saaras-test', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'workflow' },
  models: {
    asr: {
      role: 'asr',
      slug: 'whisper',
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      format: 'WHISPER_CPP',
      sourceUri: 'x',
      sourceRevision: null,
      localPath: null,
      checksum: null,
      computeType: null,
      provider: null,
      tenantId: '0'.repeat(36),
    },
  },
  audioFrontEnd: {},
  decoding: {},
  postProcessing: {},
  streaming: {},
  instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'none', autoSwitch: false, switchAfterConsecutiveFailures: 3, spec: null },
};

const mocks = () => ({
  jobService: {
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    create: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    failJob: vi.fn(),
    getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0 }),
  },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      status: 'active',
      maxConcurrent: 10,
      currentActive: 1,
      pipelineId: 'agent-v-1',
      activeEngine: 'primary',
    }),
    switchToFallback: vi.fn().mockResolvedValue(undefined),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
  binding: { bind: vi.fn(), bindSessionMeta: vi.fn(), clear: vi.fn() },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  // Stands in for lane L-B's resolver. Its `resolve` result shape is the L-B/L-C contract:
  // `{ spec: { agent: { source } }, workflowDefinitionSlug? }`.
  asrResolver: {
    resolve: vi.fn().mockResolvedValue({ spec, workflowDefinitionSlug: 'arcaai-gen-consultation' }),
  },
});

function build() {
  const m = mocks();
  const controller = new TranscriptionJobController(
    m.jobService as never,
    m.realtimeService as never,
    m.sessionService as never,
    m.cls as never,
    m.blobStorage as never,
    m.tenantBucketService as never,
    m.streamTicketService as never,
    m.binding as never,
    m.entitlements as never,
    undefined,
    m.asrResolver as never,
  );
  return { controller, m };
}

beforeEach(() => vi.clearAllMocks());

describe('TASK-1002 — createStreamSession forwards consultationId to the ASR resolver', () => {
  it('a consultation-bound session passes consultationId through to the resolver', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: 'c-1' });
  });

  it('no consultationId on the request → the resolver is called with consultationId: null', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({} as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: null });
  });

  it('an explicit agentSlug still passes consultationId alongside it', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ agentSlug: 'saaras-test', consultationId: 'c-1' } as never);
    // TASK-1004 — and, because this request declared no language, asks for the ONE consultation
    // read an explicit slug otherwise skips (the session inherits the consultation's mode).
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentSlug: 'saaras-test',
      departmentId: null,
      consultationId: 'c-1',
      inheritConsultationLanguage: true,
    });
  });

  it('the response carries agentSource from the resolved spec', async () => {
    const { controller } = build();
    const out = await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(out).toMatchObject({ agentSlug: 'saaras-test', agentVersionId: 'agent-v-1', agentSource: 'workflow' });
  });

  it('emits one stt.asr_agent_resolved log line naming the source and the governing workflow', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { controller } = build();
    await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(logSpy).toHaveBeenCalledWith({
      message: 'stt.asr_agent_resolved',
      consultationId: 'c-1',
      agentSlug: 'saaras-test',
      agentVersionId: 'agent-v-1',
      source: 'workflow',
      workflowDefinitionSlug: 'arcaai-gen-consultation',
    });
    logSpy.mockRestore();
  });

  it('a department/tenant resolution (no governing workflow ASR node) logs a null workflowDefinitionSlug', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValueOnce({ spec: { ...spec, agent: { ...spec.agent, source: 'tenant' } } });
    await controller.createStreamSession({} as never);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'stt.asr_agent_resolved', source: 'tenant', workflowDefinitionSlug: null }),
    );
    logSpy.mockRestore();
  });
});

describe('TASK-1002 — transcribeFile forwards consultationId to the ASR resolver', () => {
  const file = wavFixture(300);

  it('passes consultationId through to the resolver', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, { consultationId: 'c-2' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: 'c-2' });
  });

  it('no consultationId on the request → the resolver is called with consultationId: null', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, {} as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: null });
  });
});

describe('TASK-1002 — a WORKFLOW_ASR_AGENT_UNAVAILABLE refusal from the resolver propagates unchanged', () => {
  it('createStreamSession surfaces the 409 with its code, and never opens an STT session', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockRejectedValueOnce(
      new ConflictException({
        code: 'WORKFLOW_ASR_AGENT_UNAVAILABLE',
        reason: 'agent disabled',
        workflowDefinitionSlug: 'wf-1',
        agentSlug: 'saaras-test',
      }),
    );
    try {
      await controller.createStreamSession({ consultationId: 'c-1' } as never);
      expect.fail('expected the 409 to propagate');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getStatus()).toBe(409);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WORKFLOW_ASR_AGENT_UNAVAILABLE' });
    }
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
  });
});
