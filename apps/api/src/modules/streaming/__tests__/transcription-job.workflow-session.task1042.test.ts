/**
 * TASK-1042 (C1) — `POST audio/transcription-jobs/stream/session` takes an optional `workflowSlug`
 * (a session for a STANDALONE workflow run), mutually exclusive with `consultationId` (400
 * `STREAM_SESSION_TARGET_CONFLICT`). It is forwarded to the ASR resolver, which resolves that
 * workflow's STT node agent; the response echoes `agentSource: 'workflow'`.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

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

describe('TASK-1042 C1 — createStreamSession with workflowSlug', () => {
  it('forwards workflowSlug to the ASR resolver and echoes agentSource: workflow', async () => {
    const { controller, m } = build();
    const out = await controller.createStreamSession({ workflowSlug: 'dictate' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentSlug: null,
      departmentId: null,
      consultationId: null,
      workflowSlug: 'dictate',
    });
    expect(out).toMatchObject({ agentSource: 'workflow' });
  });

  it('400 STREAM_SESSION_TARGET_CONFLICT when both workflowSlug and consultationId are sent — before any resolution or STT I/O', async () => {
    const { controller, m } = build();
    const error = await controller.createStreamSession({ workflowSlug: 'dictate', consultationId: 'c-1' } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'STREAM_SESSION_TARGET_CONFLICT' });
    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
    expect(m.entitlements.assertConcurrencyQuota).not.toHaveBeenCalled();
  });

  it('without workflowSlug the resolver call is unchanged (no workflowSlug key)', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({} as never);
    expect(m.asrResolver.resolve.mock.calls[0][0]).not.toHaveProperty('workflowSlug');
  });
});
