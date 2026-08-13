/**
 * TranscriptionJobController — Phase D STT fallback behaviour (items 6, 7).
 *
 * Covers ONLY the new fallback surface:
 *  - `createStreamSession` resolves the tenant's effective fallback + decrypted
 *    BYO provider overrides and forwards both to the session payload; a resolve
 *    error is fail-open (session still created, no overrides, no throw).
 *  - `switchStreamSessionToFallback` fail-closed selection guard (409 when no
 *    fallback configured), happy path, and the apps/stt 409 → 409 mapping.
 *
 * The `@TenantOwnedResource` guard (cross-tenant 404) is exercised by the
 * interceptor + the cross-tenant e2e spec, not here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

// `getStatusCountsForOwner` backs the in-flight cap. Zero in flight so
// these tests exercise pipeline resolution, not the concurrency guard.
const createMockJobService = () => ({
  createBatchJob: vi.fn(),
  failJob: vi.fn(),
  getStatusCountsForOwner: vi.fn().mockResolvedValue({ queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, dead: 0 }),
});
const createMockRealtimeService = () => ({ dispatchDramatiqJob: vi.fn() });
const createMockSessionService = () => ({
  createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 }),
  removeSession: vi.fn(),
  switchToFallback: vi.fn().mockResolvedValue(undefined),
  switchProvider: vi.fn().mockResolvedValue(undefined),
  getLanguageModes: vi.fn().mockResolvedValue({ modes: [] }),
});
const createMockCls = () => ({ get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' }) });
const createMockBlobStorage = () => ({ resolveDescriptor: vi.fn().mockResolvedValue(null), putObject: vi.fn() });
const createMockTenantBucketService = () => ({ getBucketBySlug: vi.fn(), getBucketByName: vi.fn(), getBucketByPurpose: vi.fn() });
const createMockPipelineService = () => ({
  getById: vi.fn().mockImplementation(async (id: string) => ({ id, tenantId: 'tenant-1', name: 'p', slug: id })),
});
const createMockStreamTicketService = () => ({
  issueTicket: vi.fn().mockResolvedValue({ ticket: 'ticket-1', expiresAt: Date.now() + 30_000 }),
});
const createMockBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
});
const createMockEntitlements = () => ({ assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined) });
const createMockSttConfig = () => ({
  getEffective: vi
    .fn()
    .mockResolvedValue({ tenantId: 'tenant-1', fallbackPipelineId: 'fallback-pipe', autoSwitchEnabled: true, consecutiveFailureThreshold: 2 }),
  resolveProviderOverrides: vi.fn().mockResolvedValue({ sarvam: { api_key: 'secret-key' } }),
});

function build(sttConfig?: ReturnType<typeof createMockSttConfig>) {
  const mocks = {
    jobService: createMockJobService(),
    realtimeService: createMockRealtimeService(),
    sessionService: createMockSessionService(),
    cls: createMockCls(),
    blobStorage: createMockBlobStorage(),
    tenantBucketService: createMockTenantBucketService(),
    pipelineService: createMockPipelineService(),
    streamTicketService: createMockStreamTicketService(),
    binding: createMockBinding(),
    entitlements: createMockEntitlements(),
    sttConfig: sttConfig ?? createMockSttConfig(),
  };
  const controller = new TranscriptionJobController(
    mocks.jobService as never,
    mocks.realtimeService as never,
    mocks.sessionService as never,
    mocks.cls as never,
    mocks.blobStorage as never,
    mocks.tenantBucketService as never,
    mocks.pipelineService as never,
    mocks.streamTicketService as never,
    mocks.binding as never,
    mocks.entitlements as never,
    mocks.sttConfig as never,
  );
  return { controller, mocks };
}

describe('TranscriptionJobController.createStreamSession — STT fallback injection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards decrypted provider_overrides + fallback_pipeline_id to the session payload', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);
    expect(mocks.sessionService.createSession).toHaveBeenCalledTimes(1);
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect(payload.providerOverrides).toEqual({ sarvam: { api_key: 'secret-key' } });
    expect(payload.fallbackPipelineId).toBe('fallback-pipe');
  });

  it('omits overrides/fallback when the tenant has none configured', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({
      tenantId: 'tenant-1',
      fallbackPipelineId: null,
      autoSwitchEnabled: true,
      consecutiveFailureThreshold: 2,
    });
    sttConfig.resolveProviderOverrides.mockResolvedValue({});
    const { controller, mocks } = build(sttConfig);
    await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect('providerOverrides' in payload).toBe(false);
    expect('fallbackPipelineId' in payload).toBe(false);
  });

  it('is fail-open: a config resolve error still creates the session without overrides', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.resolveProviderOverrides.mockRejectedValue(new Error('vault down'));
    const { controller, mocks } = build(sttConfig);
    const result = await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);
    expect(result.sessionId).toBe('sess-1');
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect('providerOverrides' in payload).toBe(false);
    expect('fallbackPipelineId' in payload).toBe(false);
  });

  it('forwards the end-user languageMode to the session payload', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ pipelineId: 'primary-pipe', languageMode: 'ml-en' } as never);
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect(payload.languageMode).toBe('ml-en');
  });

  it('forwards startOn into the session payload', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ pipelineId: 'primary-pipe', startOn: 'fallback' } as never);
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect(payload.startOn).toBe('fallback');
  });

  it('omits startOn when not requested', async () => {
    const { controller, mocks } = build();
    await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);
    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect('startOn' in payload).toBe(false);
  });

  it('is fail-closed: startOn=fallback with no configured fallback → 409', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({
      tenantId: 'tenant-1',
      fallbackPipelineId: null,
      autoSwitchEnabled: true,
      consecutiveFailureThreshold: 2,
    });
    sttConfig.resolveProviderOverrides.mockResolvedValue({});
    const { controller, mocks } = build(sttConfig);
    await expect(controller.createStreamSession({ pipelineId: 'primary-pipe', startOn: 'fallback' } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mocks.sessionService.createSession).not.toHaveBeenCalled();
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

  it('409s when the tenant has no fallback configured (fail-closed selection)', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({
      tenantId: 'tenant-1',
      fallbackPipelineId: null,
      autoSwitchEnabled: true,
      consecutiveFailureThreshold: 2,
    });
    const { controller, mocks } = build(sttConfig);
    await expect(controller.switchStreamSessionToFallback('sess-1')).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.sessionService.switchToFallback).not.toHaveBeenCalled();
  });

  it('requests the switch and returns {switched:true} on the happy path', async () => {
    const { controller, mocks } = build();
    await expect(controller.switchStreamSessionToFallback('sess-1')).resolves.toEqual({ switched: true });
    expect(mocks.sessionService.switchToFallback).toHaveBeenCalledWith('sess-1');
  });

  it('maps an apps/stt 409 (already switched / no fallback) to a ConflictException', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.switchToFallback.mockRejectedValue({ response: { status: 409 } });
    await expect(controller.switchStreamSessionToFallback('sess-1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TranscriptionJobController.switchStreamSessionToPrimary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the primary-direction switch and returns {switched:true} on the happy path', async () => {
    const { controller, mocks } = build();
    await expect(controller.switchStreamSessionToPrimary('sess-1')).resolves.toEqual({ switched: true });
    expect(mocks.sessionService.switchProvider).toHaveBeenCalledWith('sess-1', 'primary');
  });

  it('needs no fallback-config precheck (never reads sttConfig.getEffective)', async () => {
    const { controller, mocks } = build();
    await controller.switchStreamSessionToPrimary('sess-1');
    expect(mocks.sttConfig.getEffective).not.toHaveBeenCalled();
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

/**
 * Batch auto-fallback was never dispatched.
 *
 * `transcribe_file.py:317-336` has implemented the batch fallback since
 * On a cloud-ASR/model failure it re-runs ONCE on
 * `fallback_pipeline_id` within the same Dramatiq attempt and stamps
 * `usedFallbackPipelineId` on the result. But nothing ever SUPPLIED that
 * argument — the gateway's dispatch stops at `userId` and its only kwarg is
 * `storage` — so the whole path was unreachable in production and a failing
 * primary simply failed the job.
 *
 * Streaming sessions have resolved the tenant fallback since
 * (`createStreamSession` above); batch is the half that was missed.
 */
describe('TranscriptionJobController.transcribeFile — batch fallback dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  // A 5-minute WAV: comfortably inside the ceilings, so these tests
  // still assert pipeline resolution rather than the new duration guard.
  const audioFile = () => wavFixture(300);

  it("passes the tenant's fallback pipeline into the batch job", async () => {
    const { controller, mocks } = build();
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-1', status: 'QUEUED' });

    await controller.transcribeFile(audioFile(), { pipelineId: 'primary-pipe' } as never);

    expect(mocks.realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ fallbackPipelineId: 'fallback-pipe' }));
  });

  it('omits the key entirely when the tenant has no fallback configured', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({ tenantId: 'tenant-1', fallbackPipelineId: null, autoSwitchEnabled: true });
    const { controller, mocks } = build(sttConfig);
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-2', status: 'QUEUED' });

    await controller.transcribeFile(audioFile(), { pipelineId: 'primary-pipe' } as never);

    const params = mocks.realtimeService.dispatchDramatiqJob.mock.calls[0][0];
    expect('fallbackPipelineId' in params).toBe(false);
  });

  it('is fail-open: a config resolve error still dispatches the job without a fallback', async () => {
    // A broken tenant STT config must never block a transcription — same
    // posture the streaming path already takes.
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockRejectedValue(new Error('vault down'));
    const { controller, mocks } = build(sttConfig);
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-3', status: 'QUEUED' });

    await controller.transcribeFile(audioFile(), { pipelineId: 'primary-pipe' } as never);

    expect(mocks.realtimeService.dispatchDramatiqJob).toHaveBeenCalledTimes(1);
    const params = mocks.realtimeService.dispatchDramatiqJob.mock.calls[0][0];
    expect('fallbackPipelineId' in params).toBe(false);
  });
});

/**
 * The tenant's auto-switch governance reaches the session.
 *
 * `getEffective` has always returned `autoSwitchEnabled` /
 * `consecutiveFailureThreshold`; the controller read the object and used only
 * `fallbackPipelineId`, so the governance never left the gateway and STT's
 * controller silently used its own defaults.
 */
describe('TranscriptionJobController.createStreamSession — auto-switch governance', () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the tenant's autoSwitchEnabled and consecutiveFailureThreshold", async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({
      tenantId: 'tenant-1',
      fallbackPipelineId: 'fallback-pipe',
      autoSwitchEnabled: false,
      consecutiveFailureThreshold: 5,
    });
    const { controller, mocks } = build(sttConfig);

    await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);

    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect(payload.autoSwitchEnabled).toBe(false);
    expect(payload.consecutiveFailureThreshold).toBe(5);
  });

  it('is fail-open: a config resolve error leaves the governance unset rather than blocking the session', async () => {
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockRejectedValue(new Error('vault down'));
    const { controller, mocks } = build(sttConfig);

    await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never);

    const payload = mocks.sessionService.createSession.mock.calls[0][0];
    expect(mocks.sessionService.createSession).toHaveBeenCalledTimes(1);
    expect('autoSwitchEnabled' in payload).toBe(false);
  });
});

/**
 * AC-2 — the create response carries the RESOLVED baseline.
 *
 * Until now both create paths returned only what the caller already knew. A
 * client that sent no pipelineId, a session opened on the fallback by choice,
 * and one opened there because the primary ASR failed to load were all
 * indistinguishable from a normal primary session — which is why the SDK's
 * `activePipeline` had to be derived from the request and went null.
 */
describe('TranscriptionJobController.createStreamSession — resolved pipeline echo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resolved pipelineId and activeEngine from the session service', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.createSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'active',
      maxConcurrent: 10,
      currentActive: 1,
      pipelineId: 'resolved-pipe',
      activeEngine: 'fallback',
    });

    const result = (await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never)) as Record<string, unknown>;

    expect(result.pipelineId).toBe('resolved-pipe');
    expect(result.activeEngine).toBe('fallback');
  });

  it('omits both against an older STT that echoes neither (mixed-version degrade)', async () => {
    const { controller, mocks } = build();
    mocks.sessionService.createSession.mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 });

    const result = (await controller.createStreamSession({ pipelineId: 'primary-pipe' } as never)) as Record<string, unknown>;

    expect('pipelineId' in result).toBe(false);
    expect('activeEngine' in result).toBe(false);
  });
});

/**
 * D11 — batch can say "use the tenant default".
 *
 * Live sessions have always been able to omit the pipeline (the gateway
 * resolves one), but batch hard-required it all the way down to the SDK queue,
 * so there was no way to express the same intent for an upload.
 */
describe('TranscriptionJobController.transcribeFile — tenant-default pipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  // A 5-minute WAV: comfortably inside the ceilings, so these tests
  // still assert pipeline resolution rather than the new duration guard.
  const audioFile = () => wavFixture(300);

  it("resolves the tenant's default pipeline when the request omits one", async () => {
    const { controller, mocks } = build();
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-d1', status: 'QUEUED' });
    mocks.pipelineService.getAll = vi.fn().mockResolvedValue([
      { id: 'other-pipe', isDefault: false, tenantId: 'tenant-1' },
      { id: 'tenant-default-pipe', isDefault: true, tenantId: 'tenant-1' },
    ]);

    await controller.transcribeFile(audioFile(), {} as never);

    expect(mocks.jobService.createBatchJob).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'tenant-default-pipe' }));
    expect(mocks.realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'tenant-default-pipe' }));
  });

  it('falls back to the configured fallback pipeline when no pipeline is marked default', async () => {
    const { controller, mocks } = build();
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-d2', status: 'QUEUED' });
    mocks.pipelineService.getAll = vi.fn().mockResolvedValue([{ id: 'other-pipe', isDefault: false, tenantId: 'tenant-1' }]);

    await controller.transcribeFile(audioFile(), {} as never);

    expect(mocks.realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'fallback-pipe' }));
  });

  it('409s with an explicit message when neither a default nor a fallback exists', async () => {
    // Never guess a pipeline: transcribing a consultation on an arbitrary
    // engine is worse than refusing.
    const sttConfig = createMockSttConfig();
    sttConfig.getEffective.mockResolvedValue({ tenantId: 'tenant-1', fallbackPipelineId: null, autoSwitchEnabled: true });
    const { controller, mocks } = build(sttConfig);
    mocks.pipelineService.getAll = vi.fn().mockResolvedValue([{ id: 'other-pipe', isDefault: false, tenantId: 'tenant-1' }]);

    await expect(controller.transcribeFile(audioFile(), {} as never)).rejects.toThrow(/no default .*pipeline/i);
    expect(mocks.jobService.createBatchJob).not.toHaveBeenCalled();
  });

  it('still honours an explicit pipelineId (unchanged for every existing caller)', async () => {
    const { controller, mocks } = build();
    mocks.jobService.createBatchJob.mockResolvedValue({ id: 'job-d4', status: 'QUEUED' });
    mocks.pipelineService.getAll = vi.fn();

    await controller.transcribeFile(audioFile(), { pipelineId: 'explicit-pipe' } as never);

    expect(mocks.pipelineService.getAll).not.toHaveBeenCalled();
    expect(mocks.realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'explicit-pipe' }));
  });
});
