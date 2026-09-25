/**
 * TASK-1004 §4.3 — the live entry point (`POST audio/transcription-jobs/stream/session`) applies
 * ONE spoken-language selection:
 *
 *   request (`languageMode` > `language`, normalized; unknown → 400 before any I/O)
 *     > the consultation's declared mode (inherited off the resolver's existing consultation read)
 *     > the agent's own default (left to STT, which stamps `agent`/`default` itself)
 *
 * and sends `language_mode` + `language_mode_source` to STT. The engine is never chosen by it.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1, tenantId: '0'.repeat(36), source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper', format: 'WHISPER_CPP', provider: null } },
  audioFrontEnd: {},
  decoding: { languageMode: 'en' },
  postProcessing: {},
  streaming: {},
  instruction: { initialPrompt: null, hotwords: [] },
  fallback: { kind: 'none', autoSwitch: false, switchAfterConsecutiveFailures: 3, spec: null },
};

const RECEIPT = {
  requestedMode: 'ml-en',
  source: 'consultation',
  appliedMode: 'ml-en',
  engine: 'WHISPER_CPP',
  provider: null,
  params: { language: null, codeSwitching: false, streamingEnglishGloss: false, primed: false },
  degraded: true,
  reason: 'whisper_cpp_pair_unprimed',
};

const mocks = () => ({
  jobService: { createBatchJob: vi.fn(), failJob: vi.fn(), getStatusCountsForOwner: vi.fn() },
  realtimeService: { dispatchDramatiqJob: vi.fn() },
  sessionService: {
    createSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1, languageResolution: RECEIPT }),
  },
  cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
  blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
  tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
  streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 't', expiresAt: 1 }) },
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

const sessionPayload = (m: ReturnType<typeof mocks>) => m.sessionService.createSession.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-1004 — stream session language', () => {
  it('only consultationId → inherits the consultation’s mode (source consultation), no extra read requested', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: 'c-1' });
    expect(sessionPayload(m)).toMatchObject({ languageMode: 'ml-en', languageModeSource: 'consultation' });
    expect(sessionPayload(m).language).toBeUndefined();
  });

  it('an explicit languageMode wins over the consultation (source request)', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ consultationId: 'c-1', languageMode: 'EN' } as never);
    expect(sessionPayload(m)).toMatchObject({ languageMode: 'en', languageModeSource: 'request' });
  });

  it('a BCP-47 `language` is normalized to its mode (source request) and the raw tag is not forwarded', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ consultationId: 'c-1', language: 'ml-IN' } as never);
    expect(sessionPayload(m)).toMatchObject({ languageMode: 'ml', languageModeSource: 'request' });
    expect(sessionPayload(m).language).toBeUndefined();
  });

  it('an explicit agentSlug on a consultation with no declared language asks the resolver for the ONE consultation read', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ agentSlug: 'platform-transcription', consultationId: 'c-1' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentSlug: 'platform-transcription',
      departmentId: null,
      consultationId: 'c-1',
      inheritConsultationLanguage: true,
    });
  });

  it('a request that declares its own mode never asks for the consultation read', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ agentSlug: 'platform-transcription', consultationId: 'c-1', languageMode: 'en' } as never);
    expect(m.asrResolver.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentSlug: 'platform-transcription',
      departmentId: null,
      consultationId: 'c-1',
    });
  });

  it('nothing declared anywhere → no mode is sent; STT applies the agent’s own and stamps the source itself', async () => {
    const { controller, m } = build();
    m.asrResolver.resolve.mockResolvedValue({ spec, consultationLanguageMode: null });
    await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(sessionPayload(m).languageMode).toBeUndefined();
    expect(sessionPayload(m).languageModeSource).toBeUndefined();
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN before quota, resolution or STT', async () => {
    const { controller, m } = build();
    await expect(controller.createStreamSession({ consultationId: 'c-1', language: 'klingon' } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.createStreamSession({ languageMode: 'fr' } as never)).rejects.toMatchObject({
      response: { code: 'LANGUAGE_MODE_UNKNOWN' },
    });
    expect(m.entitlements.assertConcurrencyQuota).not.toHaveBeenCalled();
    expect(m.asrResolver.resolve).not.toHaveBeenCalled();
    expect(m.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('returns the receipt on the response and freezes it on the session meta for the WS `ready`', async () => {
    const { controller, m } = build();
    const out = await controller.createStreamSession({ consultationId: 'c-1' } as never);
    expect(out.languageResolution).toEqual(RECEIPT);
    expect(m.binding.bindSessionMeta).toHaveBeenCalledWith('sess-1', expect.objectContaining({ languageResolution: RECEIPT }));
  });

  it('the language never changes the agent: two modes, the same resolver call shape', async () => {
    const { controller, m } = build();
    await controller.createStreamSession({ languageMode: 'ml-en' } as never);
    await controller.createStreamSession({ languageMode: 'en' } as never);
    expect(m.asrResolver.resolve.mock.calls[0]).toEqual(m.asrResolver.resolve.mock.calls[1]);
  });
});
