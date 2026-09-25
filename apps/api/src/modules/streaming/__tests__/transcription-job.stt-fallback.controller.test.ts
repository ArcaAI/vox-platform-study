/**
 * TranscriptionJobController — the STT fallback surface.
 *
 * TASK-1006: the fallback is a property of the resolved ASR AGENT (`ResolvedAsrSpec.fallback`),
 * and the tenant-wide `TenantSttConfig` pointer is gone. Covered here:
 *  - `createStreamSession` forwards the spec (which carries its own fallback chain), the chain's
 *    credentials and the agent's auto-switch governance — and NO fallback pointer beside them;
 *  - the `startOn` pre-start selection, fail-closed when the agent declares no fallback;
 *  - `switchStreamSessionToFallback` / `switchStreamSessionToPrimary` defer to the runtime and map
 *    its 409 / 404;
 *  - the batch job dispatch carries no fallback pointer either.
 *
 * The `@TenantOwnedResource` guard (cross-tenant 404) is exercised by the
 * interceptor + the cross-tenant e2e spec, not here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const specWith = (fallback: { autoSwitch: boolean; switchAfterConsecutiveFailures: number; spec: unknown }) => ({
  runtimeKey: 'agent-v-1',
  agent: { slug: 'clinic-transcription', versionId: 'agent-v-1', source: 'tenant' },
  models: { asr: { slug: 'whisper' } },
  audioFrontEnd: {},
  fallback: { kind: fallback.spec ? 'model' : 'none', ...fallback },
});

const WITH_FALLBACK = specWith({ autoSwitch: false, switchAfterConsecutiveFailures: 5, spec: { runtimeKey: 'agent-v-1:fallback:sarvam' } });
const WITHOUT_FALLBACK = specWith({ autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null });

// `getStatusCountsForOwner` backs the in-flight cap. Zero in flight so
// these tests exercise agent resolution, not the concurrency guard.
const createMockJobService = () => ({
  createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
  failJob: vi.fn(),
  getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, dead: 0 }),
});
const createMockSessionService = () => ({
  createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 }),
  removeSession: vi.fn(),
  switchToFallback: vi.fn().mockResolvedValue(undefined),
  switchProvider: vi.fn().mockResolvedValue(undefined),
  getLanguageModes: vi.fn().mockResolvedValue({ modes: [] }),
});

/** `providerOverrides: null` = the resolver bound no credential to the chain (a self-hosted engine). */
function build(
  spec: unknown = WITH_FALLBACK,
  providerOverrides: Record<string, unknown> | null = { sarvam: { api_key: 'secret-key', funding: 'tenant' } },
) {
  const mocks = {
    jobService: createMockJobService(),
    realtimeService: { dispatchDramatiqJob: vi.fn() },
    sessionService: createMockSessionService(),
    // Key-AWARE: `getTenantId()` reads the CLS `tenantId` key first and falls back to `user.tenantId`.
    cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) },
    blobStorage: { resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() },
    tenantBucketService: { getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() },
    streamTicketService: { issueTicket: vi.fn().mockResolvedValue({ ticket: 'ticket-1', expiresAt: Date.now() + 30_000 }) },
    binding: {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    entitlements: { assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined) },
    asrResolver: { resolve: vi.fn().mockResolvedValue({ spec, providerOverrides: providerOverrides ?? undefined }) },
  };
  const controller = new TranscriptionJobController(
    mocks.jobService as never,
    mocks.realtimeService as never,
    mocks.sessionService as never,
    mocks.cls as never,
    mocks.blobStorage as never,
    mocks.tenantBucketService as never,
    mocks.streamTicketService as never,
    mocks.binding as never,
    mocks.entitlements as never,
    undefined,
    mocks.asrResolver as never,
  );
  return { controller, mocks };
}

const payloadOf = (mocks: ReturnType<typeof build>['mocks']) => mocks.sessionService.createSession.mock.calls[0][0] as Record<string, unknown>;

describe('TranscriptionJobController.createStreamSession — the agent carries the fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the spec and the chain credentials, and NO fallback pointer beside the spec', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({} as never);
    const payload = payloadOf(mocks);
    expect(payload.resolvedSpec).toEqual(WITH_FALLBACK);
    expect(payload.providerOverrides).toEqual({ sarvam: { api_key: 'secret-key', funding: 'tenant' } });
    expect(payload).not.toHaveProperty('fallbackPipelineId');
    expect(payload).not.toHaveProperty('pipelineId');
  });

  it('omits providerOverrides when the chain needs no credential', async () => {
    const { controller, mocks } = build(WITHOUT_FALLBACK, null);
    await controller.createStreamSession({} as never);
    expect('providerOverrides' in payloadOf(mocks)).toBe(false);
  });

  it("forwards the AGENT's auto-switch governance (spec.fallback), including an explicit false", async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({} as never);
    const payload = payloadOf(mocks);
    expect(payload.autoSwitchEnabled).toBe(false);
    expect(payload.consecutiveFailureThreshold).toBe(5);
  });

  it('forwards the end-user languageMode to the session payload', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ languageMode: 'ml-en' } as never);
    expect(payloadOf(mocks).languageMode).toBe('ml-en');
  });

  it('forwards startOn into the session payload', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ startOn: 'fallback' } as never);
    expect(payloadOf(mocks).startOn).toBe('fallback');
  });

  it('omits startOn when not requested', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({} as never);
    expect('startOn' in payloadOf(mocks)).toBe(false);
  });

  it('is fail-closed: startOn=fallback when the agent declares no fallback → 409, nothing forwarded', async () => {
    const { controller, mocks } = build(WITHOUT_FALLBACK);
    await expect(controller.createStreamSession({ startOn: 'fallback' } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.sessionService.createSession).not.toHaveBeenCalled();
  });
});

describe('TranscriptionJobController.createStreamSession — the engine baseline echo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the activeEngine STT opened on — and never a pipelineId', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.createSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'active',
      maxConcurrent: 10,
      currentActive: 1,
      activeEngine: 'fallback',
    });

    const result = (await controller.createStreamSession({} as never)) as unknown as Record<string, unknown>;

    expect(result.activeEngine).toBe('fallback');
    expect('pipelineId' in result).toBe(false);
    expect(result.agentSlug).toBe('clinic-transcription');
  });

  it('omits activeEngine against an older STT that does not echo it (mixed-version degrade)', async () => {
    const { controller } = build();

    const result = (await controller.createStreamSession({} as never)) as unknown as Record<string, unknown>;

    expect('activeEngine' in result).toBe(false);
  });
});

describe('TranscriptionJobController.getLanguageModes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the streaming session service catalog', async () => {
    const catalog = {
      modes: [
        {
          id: 'ml-en',
          label: 'Malayalam + English',
          kind: 'code_switch',
          primaryLanguage: 'ml',
          secondaryLanguage: 'en',
          supportedEngines: ['SARVAM'],
        },
      ],
    };
    const { controller, mocks } = build();
    mocks.sessionService.getLanguageModes.mockResolvedValue(catalog);
    await expect(controller.getLanguageModes()).resolves.toEqual(catalog);
    expect(mocks.sessionService.getLanguageModes).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptionJobController.switchStreamSessionToFallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the switch and returns {switched:true} on the happy path — the runtime is the authority', async () => {
    const { controller, mocks } = build();
    await expect(controller.switchStreamSessionToFallback('sess-1')).resolves.toEqual({ switched: true });
    expect(mocks.sessionService.switchToFallback).toHaveBeenCalledWith('sess-1', 'tenant-1');
    expect(mocks.asrResolver.resolve).not.toHaveBeenCalled();
  });

  it('maps an apps/stt 409 (already switched / the agent declares none) to a ConflictException', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.switchToFallback.mockRejectedValue({ response: { status: 409 } });
    await expect(controller.switchStreamSessionToFallback('sess-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an apps/stt 404 (unknown session) to a NotFoundException', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.switchToFallback.mockRejectedValue({ response: { status: 404 } });
    await expect(controller.switchStreamSessionToFallback('sess-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TranscriptionJobController.switchStreamSessionToPrimary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the primary-direction switch and returns {switched:true} on the happy path', async () => {
    const { controller, mocks } = build();
    await expect(controller.switchStreamSessionToPrimary('sess-1')).resolves.toEqual({ switched: true });
    expect(mocks.sessionService.switchProvider).toHaveBeenCalledWith('sess-1', 'primary', 'tenant-1');
  });

  it('maps an apps/stt 409 (already on primary / primary never loaded) to a ConflictException', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.switchProvider.mockRejectedValue({ response: { status: 409 } });
    await expect(controller.switchStreamSessionToPrimary('sess-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an apps/stt 404 (unknown session) to a NotFoundException', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.switchProvider.mockRejectedValue({ response: { status: 404 } });
    await expect(controller.switchStreamSessionToPrimary('sess-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TranscriptionJobController.transcribeFile — batch dispatch carries the spec, not a pointer', () => {
  beforeEach(() => vi.clearAllMocks());

  // A 5-minute WAV: comfortably inside the ceilings.
  const audioFile = () => wavFixture(300);

  it('dispatches the resolved spec (fallback included) with no fallbackPipelineId / pipelineId key', async () => {
    const { controller, mocks } = build();

    await controller.transcribeFile(audioFile(), {} as never);

    const params = mocks.realtimeService.dispatchDramatiqJob.mock.calls[0][0] as Record<string, unknown>;
    expect(params.resolvedSpec).toEqual(WITH_FALLBACK);
    expect('fallbackPipelineId' in params).toBe(false);
    expect('pipelineId' in params).toBe(false);
  });
});
