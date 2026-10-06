/**
 * TASK-1048 (owner rule 3, 2026-10-06) — "a user starting an agent/workflow whose prerequisites are
 * unmet MUST get a notice". The ASR resolver no longer refuses an agent whose OPTIONAL stage cannot
 * run; it returns `warnings`. Every creation route that resolves an agent hands them to the caller:
 * the stream session (consultation, standalone workflow run, or neither), `POST transcribe`, and the
 * three JSON job-create routes. No warnings ⇒ no `warnings` key (the response is byte-identical to
 * before).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrSessionWarningResponse, BatchTranscribeResponse, StreamSessionResponse } from '../dto';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'sarvam-diarization', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'explicit' },
  models: { asr: { role: 'asr', slug: 'saaras', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', format: 'API', sourceUri: 'x', tenantId: '0'.repeat(36) } },
  audioFrontEnd: { diarization: { enabled: false, backend: 'embedding' } },
  decoding: {},
  postProcessing: {},
  streaming: {},
  instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, chain: [], spec: null },
};

const WARNING = {
  code: 'DIARIZATION_MODEL_MISSING',
  stage: 'diarization',
  severity: 'WARNING',
  message: 'Speaker diarization is off for this session: …',
  agentSlug: 'sarvam-diarization',
  agentVersionNumber: 1,
} as const;

const mocks = () => ({
  jobService: {
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    create: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    createStreamingJob: vi.fn().mockResolvedValue({ id: 'job-2', status: 'QUEUED' }),
    failJob: vi.fn(),
    getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0 }),
  },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1, activeEngine: 'primary' }),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
  binding: { bind: vi.fn(), bindSessionMeta: vi.fn(), clear: vi.fn() },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  asrResolver: { resolve: vi.fn().mockResolvedValue({ spec, warnings: [WARNING] }) },
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

describe('stream session — the resolver’s warnings reach the caller', () => {
  it('a degraded agent opens (201 path) and the response carries the warnings', async () => {
    const { controller } = build();
    const out = await controller.createStreamSession({ agentSlug: 'sarvam-diarization' } as never);
    expect(out).toMatchObject({ sessionId: 'sess-1', agentSlug: 'sarvam-diarization', warnings: [WARNING] });
  });

  it('the standalone workflow-run session (workflowSlug) carries them too', async () => {
    const { controller } = build();
    const out = await controller.createStreamSession({ workflowSlug: 'dictate' } as never);
    expect(out.warnings).toEqual([WARNING]);
  });

  it('no warnings ⇒ no warnings key', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValueOnce({ spec });
    const out = await controller.createStreamSession({} as never);
    expect(out).not.toHaveProperty('warnings');
  });

  it('the warnings never travel to STT inside the session payload', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({} as never);
    expect(JSON.stringify(m.sessionService.createSession.mock.calls[0][0])).not.toContain('DIARIZATION_MODEL_MISSING');
  });
});

describe('batch jobs — the resolver’s warnings reach the caller', () => {
  it('POST transcribe', async () => {
    const { controller, m } = build();
    const out = await controller.transcribeFile(wavFixture(300), { agentSlug: 'sarvam-diarization' } as never);
    expect(out.warnings).toEqual([WARNING]);
    // Never persisted on the job row or put on the queue.
    expect(JSON.stringify(m.jobService.createBatchJob.mock.calls[0][0])).not.toContain('DIARIZATION_MODEL_MISSING');
    expect(JSON.stringify(m.realtimeService.dispatchDramatiqJob.mock.calls[0][0])).not.toContain('DIARIZATION_MODEL_MISSING');
  });

  it('POST transcribe with no warnings has no warnings key', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValueOnce({ spec });
    expect(await controller.transcribeFile(wavFixture(300), {} as never)).not.toHaveProperty('warnings');
  });

  it.each([
    ['create', 'create'],
    ['createBatch', 'createBatchJob'],
    ['createStreaming', 'createStreamingJob'],
  ] as const)('JSON %s returns the job plus the warnings, and never hands them to the job service', async (route, serviceMethod) => {
    const { controller, m } = build();
    const out = await (controller[route] as (dto: unknown) => Promise<Record<string, unknown>>)({ mediaId: 'media-1' });
    expect(out).toMatchObject({ status: 'QUEUED', warnings: [WARNING] });
    expect(m.jobService[serviceMethod].mock.calls[0][0]).not.toHaveProperty('warnings');
  });

  it('JSON job-create with no warnings returns the service’s own object untouched', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValueOnce({ spec });
    const job = { id: 'job-1', status: 'QUEUED' };
    m.jobService.createBatchJob.mockResolvedValueOnce(job);
    expect(await controller.createBatch({ mediaId: 'media-1' } as never)).toBe(job);
  });
});

describe('the documented response shape', () => {
  const props = (cls: object): Record<string, { type?: unknown; isArray?: boolean; required?: boolean }> => {
    const names = (Reflect.getMetadata('swagger/apiModelPropertiesArray', (cls as { prototype: object }).prototype) ?? []) as string[];
    return Object.fromEntries(
      names.map((n) => [n.replace(/^:/, ''), Reflect.getMetadata('swagger/apiModelProperties', (cls as { prototype: object }).prototype, n.replace(/^:/, ''))]),
    );
  };

  it.each([
    ['StreamSessionResponse', StreamSessionResponse],
    ['BatchTranscribeResponse', BatchTranscribeResponse],
  ])('%s documents an OPTIONAL warnings array of AsrSessionWarningResponse', (_name, cls) => {
    const warnings = props(cls).warnings;
    expect(warnings).toBeDefined();
    expect(warnings.required).toBe(false);
    expect(warnings.isArray).toBe(true);
    expect(warnings.type).toBe(AsrSessionWarningResponse);
  });

  it('AsrSessionWarningResponse documents every field of the frozen AsrSessionWarning contract', () => {
    expect(Object.keys(props(AsrSessionWarningResponse)).sort()).toEqual(
      ['agentSlug', 'agentVersionNumber', 'code', 'message', 'severity', 'stage'].sort(),
    );
  });
});
