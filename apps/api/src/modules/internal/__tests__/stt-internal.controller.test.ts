/**
 * `SttInternalController.ensureInternalApiKey`
 * runtime guard, pinned via the typed `RequestWithAuth` parameter.
 *
 * Previously the controller read `request['apiKey']` via bracket-notation;
 * a typo (`request['aip_key']`) would silently resolve to `undefined`
 * and skip the auth check. The new typed dot-access (`request.apiKey`)
 * makes that typo a TypeScript error. This test pins the runtime
 * behaviour the typed interface guards.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import { SttInternalController } from '../stt-internal.controller';

describe('SttInternalController.ensureInternalApiKey', () => {
  let controller: SttInternalController;
  let sttInternalService: any;

  beforeEach(() => {
    sttInternalService = {
      createTranscript: vi.fn(),
      startJob: vi.fn(),
      updateProgress: vi.fn(),
      completeJob: vi.fn(),
      failJob: vi.fn(),
      getJobStatus: vi.fn(),
      createAudioRecord: vi.fn(),
      createMedia: vi.fn(),
    };
    controller = new SttInternalController(sttInternalService);
  });

  it('throws UnauthorizedException when `apiKey` is undefined on the request', async () => {
    const request = {} as any;
    await expect(
      controller.createTranscript(request, {} as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(sttInternalService.createTranscript).not.toHaveBeenCalled();
  });

  it('proceeds to the service when `apiKey` is set on the request', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    sttInternalService.createTranscript.mockResolvedValue({ id: 'tx-1' });

    const result = await controller.createTranscript(request, { contextItemId: 'c-1' } as any);

    expect(result).toEqual({ id: 'tx-1' });
    expect(sttInternalService.createTranscript).toHaveBeenCalledWith({ contextItemId: 'c-1' }, undefined);
  });

  // F-09: the forward-compatible `Idempotency-Key` header STT-v2 already
  // sends is now read through (`@Headers('idempotency-key')`) and passed to
  // the service so the streaming-transcript create path can dedup a
  // concurrent/retried finalize instead of silently duplicating.
  it('reads the Idempotency-Key header and passes it through to the service', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    sttInternalService.createTranscript.mockResolvedValue({ id: 'tx-2' });

    const result = await controller.createTranscript(request, { consultationId: 'c-2' } as any, 'consultation-2:session-9');

    expect(result).toEqual({ id: 'tx-2' });
    expect(sttInternalService.createTranscript).toHaveBeenCalledWith({ consultationId: 'c-2' }, 'consultation-2:session-9');
  });

  it('does NOT accept a typo field (e.g., `aip_key`) as a substitute for `apiKey`', async () => {
    // Runtime regression for the typo class: even though `request.aip_key`
    // is set, the controller MUST read `request.apiKey` and reject. The
    // typed `RequestWithAuth` interface enforces this at compile-time;
    // this test makes the runtime expectation explicit too.
    const request = { aip_key: { id: 'typo-key' } } as any;
    await expect(
      controller.createTranscript(request, {} as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  // POST internal/stt/media: register a storage object as Media.
  describe('createMedia', () => {
    it('throws UnauthorizedException when `apiKey` is undefined', async () => {
      const request = {} as any;
      await expect(controller.createMedia(request, {} as any)).rejects.toThrow(UnauthorizedException);
      expect(sttInternalService.createMedia).not.toHaveBeenCalled();
    });

    it('delegates to the service and returns the created media id when authorized', async () => {
      const request = { apiKey: { id: 'key-1' } } as any;
      const dto = { tenantId: 't-1', name: 'x.wav', uri: 's3://b/x.wav', extension: 'wav', mimeType: 'audio/wav', size: 10, hash: '' } as any;
      sttInternalService.createMedia.mockResolvedValue({ id: 'media-1' });

      const result = await controller.createMedia(request, dto);

      expect(result).toEqual({ id: 'media-1' });
      expect(sttInternalService.createMedia).toHaveBeenCalledWith(dto);
    });
  });
});

// TASK-567 §5 item 8: the batch-worker BYO override PULL route.
describe('SttInternalController.getProviderOverrides', () => {
  let sttInternalService: any;
  let sttConfig: any;
  let cls: any;
  let controller: SttInternalController;

  beforeEach(() => {
    sttInternalService = { createTranscript: vi.fn() };
    sttConfig = { resolveProviderOverrides: vi.fn().mockResolvedValue({ sarvam: { api_key: 'k' } }) };
    // Minimal CLS: `run` invokes the callback synchronously, `set` records the tenant.
    cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
    controller = new SttInternalController(sttInternalService, sttConfig, cls);
  });

  it('rejects when the internal API key is absent (service-to-service gate)', async () => {
    await expect(controller.getProviderOverrides({} as any, 't-1')).rejects.toThrow(UnauthorizedException);
    expect(sttConfig.resolveProviderOverrides).not.toHaveBeenCalled();
  });

  it('400s when tenantId is missing', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    await expect(controller.getProviderOverrides(request, undefined)).rejects.toThrow(BadRequestException);
    expect(sttConfig.resolveProviderOverrides).not.toHaveBeenCalled();
  });

  it('resolves overrides within a tenant-pinned CLS context when authorized', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    const result = await controller.getProviderOverrides(request, 't-1');
    expect(result).toEqual({ sarvam: { api_key: 'k' } });
    expect(cls.set).toHaveBeenCalledWith('tenantId', 't-1');
    expect(sttConfig.resolveProviderOverrides).toHaveBeenCalledWith('t-1');
  });
});
