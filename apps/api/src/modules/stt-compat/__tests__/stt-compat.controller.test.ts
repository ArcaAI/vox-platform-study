import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { SttCompatController } from '../stt-compat.controller';
import { StartSessionRequest } from '../dto/start-session.request';
import { SwitchSessionRequest } from '../dto/switch-session.request';

const controller = new SttCompatController();

const request = (overrides: Partial<StartSessionRequest['audioSettings']> = {}): StartSessionRequest => ({
  session_id: 'session_123456789',
  language: 'en-US',
  provider: 'azure',
  audioSettings: {
    sampleRate: 44100,
    format: 'pcm',
    channels: 1,
    bitDepth: 16,
    chunkSize: 1024,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: false,
    ...overrides,
  },
});

describe('SttCompatController.startSession', () => {
  it('returns the exact v1 response envelope', async () => {
    const res = await controller.startSession(request());
    expect(res).toEqual({
      message: 'Session started',
      session_id: 'session_123456789',
      status: 'active',
      provider: 'azure',
      audio_config: {
        sampleRate: 44100,
        format: 'pcm',
        channels: 1,
        bitDepth: 16,
        chunkSize: 1024,
        noiseCancellation: true,
        echoCancellation: true,
        autoGainControl: false,
        compressed_stream_format: null,
        wave_stream_format: 1,
      },
    });
  });

  it('overrides audio_config from matching client keys, keeping noiseCancellation default', async () => {
    const res = await controller.startSession(request({ sampleRate: 8000, echoCancellation: false, noiseSuppression: false }));
    expect(res.audio_config.sampleRate).toBe(8000);
    expect(res.audio_config.echoCancellation).toBe(false);
    expect(res.audio_config.noiseCancellation).toBe(true);
  });

  it('maps Whisper to Azure and preserves other providers', async () => {
    for (const provider of ['azure', 'whisper', 'sarvam'] as const) {
      const expectedProvider = provider === 'whisper' ? 'azure' : provider;
      await expect(controller.startSession({ ...request(), provider })).resolves.toMatchObject({ provider: expectedProvider });
    }
  });

  it('echoes session_id', async () => {
    const res = await controller.startSession({ ...request(), session_id: 'sess-xyz' });
    expect(res.session_id).toBe('sess-xyz');
  });

  it('defaults to Azure when no provider is supplied', async () => {
    const { provider: _omit, ...noProvider } = request();
    const res = await controller.startSession(noProvider as StartSessionRequest);
    expect(res.provider).toBe('azure');
  });
});
describe('SttCompatController streaming integration', () => {
  it('creates and binds a v2 streaming session after normalizing Whisper to Azure', async () => {
    const pipelineService = {
      getAll: vi
        .fn()
        .mockResolvedValue([{ id: 'azure-pipeline', slug: 'azure-speech-transcription', name: 'Azure', tags: ['azure'], isDefault: false }]),
    };
    const sessionService = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session_123456789', status: 'active' }),
      removeSession: vi.fn().mockResolvedValue(undefined),
    };
    const sessionBinding = {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const sessionMetadata = {
      setLanguage: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const cls = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      run: vi.fn((callback: () => Promise<unknown>) => callback()),
    };
    const apiKeyService = {
      authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1' }),
    };
    const integrated = new SttCompatController(
      pipelineService as any,
      sessionService as any,
      sessionBinding as any,
      cls as any,
      apiKeyService as any,
      sessionMetadata as any,
    );

    const response = await integrated.startSession({ ...request(), provider: 'whisper' }, { headers: { 'x-api-key': 'legacy-key' } });
    expect(response.provider).toBe('azure');

    expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('legacy-key', undefined);
    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_123456789',
        tenantId: 'tenant-1',
        pipelineId: 'azure-pipeline',
        sampleRate: 44100,
      }),
    );
    expect(sessionBinding.bind).toHaveBeenCalledWith('session_123456789', 'tenant-1', 'user-1');
    expect(sessionBinding.bindSessionMeta).toHaveBeenCalledWith('session_123456789', { sampleRate: 44100 });
    expect(sessionMetadata.setLanguage).toHaveBeenCalledWith('session_123456789', 'en-US');
  });

  it('stops and clears a v2 streaming session', async () => {
    const sessionService = { removeSession: vi.fn().mockResolvedValue(undefined) };
    const sessionBinding = { clear: vi.fn().mockResolvedValue(undefined), lookup: vi.fn().mockResolvedValue('tenant-1') };
    const integrated = new SttCompatController(undefined, sessionService as any, sessionBinding as any);

    const response = await integrated.stopSession({ size: 4 } as Express.Multer.File, {
      session_id: 'session_123456789',
      sample_rate: 44100,
      channels: 1,
      bit_depth: 16,
    });

    // the tenant comes from the session's own binding, not CLS — this
    // compat surface is API-key authenticated.
    expect(sessionService.removeSession).toHaveBeenCalledWith('session_123456789', false, 'tenant-1');
    expect(sessionBinding.clear).toHaveBeenCalledWith('session_123456789');
    expect(response).toMatchObject({
      message: 'Session stopped and audio saved',
      session_id: 'session_123456789',
      status: 'stopped',
      audio_uploaded: true,
      audio_config: {
        sample_rate: 44100,
        channels: 1,
        bit_depth: 16,
        size_bytes: 4,
      },
    });
  });
  it('omits audio details when no audio is uploaded', async () => {
    const response = await controller.stopSession(undefined, { session_id: 'session_123456789' });

    expect(response).toEqual({
      message: 'Session stopped',
      session_id: 'session_123456789',
      status: 'stopped',
      audio_uploaded: false,
    });
  });
});

describe('SttCompatController.startSession — pipelineId + fallback wiring (C4)', () => {
  const wire = (over: { sttConfig?: unknown } = {}) => {
    const pipelineService = {
      getAll: vi.fn().mockResolvedValue([{ id: 'azure-pipeline', slug: 'azure-speech', name: 'Azure', tags: ['azure'], isDefault: true }]),
    };
    const sessionService = { createSession: vi.fn().mockResolvedValue({ sessionId: 'session_123456789', status: 'active' }) };
    const sessionBinding = {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), run: vi.fn((cb: () => Promise<unknown>) => cb()) };
    const apiKeyService = { authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1' }) };
    const sessionMetadata = { setLanguage: vi.fn().mockResolvedValue(undefined) };
    const controller = new SttCompatController(
      pipelineService as any,
      sessionService as any,
      sessionBinding as any,
      cls as any,
      apiKeyService as any,
      sessionMetadata as any,
      over.sttConfig as any,
    );
    return { controller, pipelineService, sessionService };
  };

  it('uses an explicit pipelineId directly and never calls selectPipeline/getAll', async () => {
    const { controller, pipelineService, sessionService } = wire();
    await controller.startSession({ ...request(), pipelineId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } as StartSessionRequest, {
      headers: { 'x-api-key': 'legacy-key' },
    });
    expect(pipelineService.getAll).not.toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', tenantId: 'tenant-1' }),
    );
  });

  it('forwards resolved providerOverrides + fallbackPipelineId into createSession (fail-open helper)', async () => {
    const sttConfig = {
      getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: 'fallback-pipeline' }),
      resolveProviderOverrides: vi.fn().mockResolvedValue({ sarvam: { api_key: 'byo-key' } }),
    };
    const { controller, sessionService } = wire({ sttConfig });
    await controller.startSession(request(), { headers: { 'x-api-key': 'legacy-key' } });
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOverrides: { sarvam: { api_key: 'byo-key' } },
        fallbackPipelineId: 'fallback-pipeline',
      }),
    );
  });

  it('maps startOn:default → fallback into createSession', async () => {
    const sttConfig = {
      getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: 'fallback-pipeline' }),
      resolveProviderOverrides: vi.fn().mockResolvedValue({}),
    };
    const { controller, sessionService } = wire({ sttConfig });
    await controller.startSession({ ...request(), startOn: 'default' } as StartSessionRequest, { headers: { 'x-api-key': 'legacy-key' } });
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ startOn: 'fallback' }));
  });

  it('maps startOn:pipeline → primary into createSession', async () => {
    const { controller, sessionService } = wire();
    await controller.startSession({ ...request(), startOn: 'pipeline' } as StartSessionRequest, { headers: { 'x-api-key': 'legacy-key' } });
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ startOn: 'primary' }));
  });

  it('omits startOn from createSession when not requested', async () => {
    const { controller, sessionService } = wire();
    await controller.startSession(request(), { headers: { 'x-api-key': 'legacy-key' } });
    const payload = sessionService.createSession.mock.calls[0][0];
    expect('startOn' in payload).toBe(false);
  });

  it('is fail-closed: startOn:default with no configured fallback → 409', async () => {
    const sttConfig = {
      getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: null }),
      resolveProviderOverrides: vi.fn().mockResolvedValue({}),
    };
    const { controller, sessionService } = wire({ sttConfig });
    await expect(
      controller.startSession({ ...request(), startOn: 'default' } as StartSessionRequest, { headers: { 'x-api-key': 'legacy-key' } }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('creates the session even when the fallback config resolve throws (fail-open, no overrides)', async () => {
    const sttConfig = {
      getEffective: vi.fn().mockRejectedValue(new Error('vault down')),
      resolveProviderOverrides: vi.fn().mockRejectedValue(new Error('vault down')),
    };
    const { controller, sessionService } = wire({ sttConfig });
    await controller.startSession(request(), { headers: { 'x-api-key': 'legacy-key' } });
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerOverrides: undefined, fallbackPipelineId: undefined, tenantId: 'tenant-1' }),
    );
  });
});

describe('SttCompatController.switchSession (C3)', () => {
  const wire = (over: { lookup?: unknown; effective?: unknown; switchImpl?: unknown } = {}) => {
    const sessionService = { switchProvider: over.switchImpl ?? vi.fn().mockResolvedValue(undefined) };
    const sessionBinding = { lookup: vi.fn().mockResolvedValue(over.lookup === undefined ? 'tenant-1' : over.lookup) };
    const apiKeyService = { authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }) };
    const sttConfig = { getEffective: vi.fn().mockResolvedValue(over.effective ?? { fallbackPipelineId: 'fallback-pipeline' }) };
    const controller = new SttCompatController(
      undefined,
      sessionService as any,
      sessionBinding as any,
      undefined,
      apiKeyService as any,
      undefined,
      sttConfig as any,
    );
    return { controller, sessionService, sessionBinding, sttConfig };
  };
  const headers = { headers: { 'x-api-key': 'legacy-key' } };

  it('503s when the streaming service is unavailable', async () => {
    const controller = new SttCompatController();
    await expect(controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('404s an unknown/foreign session (binding lookup mismatch)', async () => {
    const { controller } = wire({ lookup: null });
    await expect(controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the bound tenant differs from the caller tenant', async () => {
    const { controller } = wire({ lookup: 'other-tenant' });
    await expect(controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s a default/fallback switch when the tenant has no fallback configured (fail-closed)', async () => {
    const { controller, sessionService } = wire({ effective: { fallbackPipelineId: null } });
    await expect(controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(ConflictException);
    expect(sessionService.switchProvider).not.toHaveBeenCalled();
  });

  it('maps default→fallback and echoes active:default', async () => {
    const { controller, sessionService } = wire();
    const res = await controller.switchSession({ session_id: 's1', target: 'default' }, headers);
    expect(sessionService.switchProvider).toHaveBeenCalledWith('s1', 'fallback', 'tenant-1');
    expect(res).toEqual({ switched: true, active: 'default' });
  });

  it('maps pipeline→primary and echoes active:pipeline (no fallback-config check)', async () => {
    const { controller, sessionService, sttConfig } = wire();
    const res = await controller.switchSession({ session_id: 's1', target: 'pipeline' }, headers);
    expect(sessionService.switchProvider).toHaveBeenCalledWith('s1', 'primary', 'tenant-1');
    expect(sttConfig.getEffective).not.toHaveBeenCalled();
    expect(res).toEqual({ switched: true, active: 'pipeline' });
  });

  it('surfaces a downstream 409 as 409 and 404 as 404', async () => {
    const conflict = wire({ switchImpl: vi.fn().mockRejectedValue({ response: { status: 409 } }) });
    await expect(conflict.controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(ConflictException);

    const missing = wire({ switchImpl: vi.fn().mockRejectedValue({ response: { status: 404 } }) });
    await expect(missing.controller.switchSession({ session_id: 's1', target: 'default' }, headers)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SwitchSessionRequest validation', () => {
  it('accepts every supported target token', async () => {
    for (const target of ['pipeline', 'default', 'primary', 'fallback'] as const) {
      const dto = plainToInstance(SwitchSessionRequest, { session_id: 's1', target });
      expect(await validate(dto)).toHaveLength(0);
    }
  });
  it('rejects an unknown target token', async () => {
    const dto = plainToInstance(SwitchSessionRequest, { session_id: 's1', target: 'bogus' });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('StartSessionRequest validation', () => {
  const base = () => ({
    session_id: 'session_123456789',
    language: 'en-US',
    audioSettings: {
      sampleRate: 44100,
      format: 'pcm',
      channels: 1,
      bitDepth: 16,
      chunkSize: 1024,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: false,
    },
  });

  it('accepts a body with no provider (Azure is the default)', async () => {
    const dto = plainToInstance(StartSessionRequest, base());
    expect(await validate(dto)).toHaveLength(0);
  });
  it('accepts null language for auto-detect mode', async () => {
    const dto = plainToInstance(StartSessionRequest, { ...base(), language: null });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts every supported provider value', async () => {
    for (const provider of ['azure', 'whisper', 'sarvam'] as const) {
      const dto = plainToInstance(StartSessionRequest, { ...base(), provider });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('rejects an unknown provider value', async () => {
    const dto = plainToInstance(StartSessionRequest, { ...base(), provider: 'bogus' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts startOn tokens pipeline/default', async () => {
    for (const startOn of ['pipeline', 'default'] as const) {
      const dto = plainToInstance(StartSessionRequest, { ...base(), startOn });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('rejects an unknown startOn value', async () => {
    const dto = plainToInstance(StartSessionRequest, { ...base(), startOn: 'fallback' });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
