/**
 * TranscriptionJobController — TASK-567 Phase D STT fallback behaviour (§5 items 6, 7).
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
import { ConflictException } from '@nestjs/common';
import { TranscriptionJobController } from '../transcription-job.controller';

const createMockJobService = () => ({ createBatchJob: vi.fn(), failJob: vi.fn() });
const createMockRealtimeService = () => ({ dispatchDramatiqJob: vi.fn() });
const createMockSessionService = () => ({
  createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', status: 'active', maxConcurrent: 10, currentActive: 1 }),
  removeSession: vi.fn(),
  switchToFallback: vi.fn().mockResolvedValue(undefined),
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
