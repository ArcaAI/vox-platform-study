/**
 * TASK-1004 — `POST audio/transcription-jobs/transcribe` (batch) applies the same ONE selection as
 * the live path: request (`languageMode` > `language`, normalized; unknown → 400 before any I/O) >
 * the consultation's declared mode (off the resolver's own read) > the agent's own (left to STT).
 * The worker gets it as the `language_mode` / `language_mode_source` kwargs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper', format: 'WHISPER_CPP', provider: null } },
  audioFrontEnd: { diarization: { enabled: false } },
  decoding: { languageMode: 'en' },
  fallback: { kind: 'none', spec: null },
};

const mocks = () => ({
  jobService: {
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    failJob: vi.fn(),
    getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0 }),
  },
  realtimeService: { dispatchDramatiqJob: vi.fn().mockResolvedValue(undefined) },
  sessionService: { createSession: vi.fn() },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn().mockResolvedValue(undefined) },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  streamTicketService: { issueTicket: vi.fn() },
  binding: { bind: vi.fn(), bindSessionMeta: vi.fn(), clear: vi.fn() },
  entitlements: { assertConcurrencyQuota: vi.fn() },
  asrResolver: { resolve: vi.fn().mockResolvedValue({ spec, consultationLanguageMode: 'ml-en' }) },
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

const dispatched = (m: ReturnType<typeof mocks>) => m.realtimeService.dispatchDramatiqJob.mock.calls[0]![0] as Record<string, unknown>;
const file = wavFixture(30);

beforeEach(() => vi.clearAllMocks());

describe('TASK-1004 — batch transcribe language', () => {
  it('only consultationId → inherits the consultation’s mode (source consultation)', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, { consultationId: 'c-1' } as never);
    expect(dispatched(m)).toMatchObject({ languageMode: 'ml-en', languageModeSource: 'consultation' });
  });

  it('an explicit languageMode wins (source request)', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, { consultationId: 'c-1', languageMode: 'en' } as never);
    expect(dispatched(m)).toMatchObject({ languageMode: 'en', languageModeSource: 'request' });
  });

  it('an explicit agentSlug on a consultation with no declared language asks for the one consultation read', async () => {
    const { controller, m } = build();
    await controller.transcribeFile(file, { agentSlug: 'platform-transcription', consultationId: 'c-1' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ consultationId: 'c-1', inheritConsultationLanguage: true }));
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN before storage, the job row or the queue', async () => {
    const { controller, m } = build();
    await expect(controller.transcribeFile(file, { languageMode: 'tlh' } as never)).rejects.toMatchObject({
      response: { code: 'LANGUAGE_MODE_UNKNOWN' },
    });
    expect(m.jobService.createBatchJob).not.toHaveBeenCalled();
    expect(m.blobStorage.putObject).not.toHaveBeenCalled();
    expect(m.realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('nothing declared → no mode sent (STT applies the agent’s own)', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValue({ spec });
    await controller.transcribeFile(file, {} as never);
    expect(dispatched(m).languageMode).toBeUndefined();
  });
});
