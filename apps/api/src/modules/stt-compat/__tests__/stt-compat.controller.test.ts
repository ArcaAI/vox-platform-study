import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { SttCompatController } from '../stt-compat.controller';
import { StartSessionRequest } from '../dto/start-session.request';

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
    expect(sessionBinding.bind).toHaveBeenCalledWith('session_123456789', 'tenant-1');
    expect(sessionBinding.bindSessionMeta).toHaveBeenCalledWith('session_123456789', { sampleRate: 44100 });
    expect(sessionMetadata.setLanguage).toHaveBeenCalledWith('session_123456789', 'en-US');
  });

  it('stops and clears a v2 streaming session', async () => {
    const sessionService = { removeSession: vi.fn().mockResolvedValue(undefined) };
    const sessionBinding = { clear: vi.fn().mockResolvedValue(undefined) };
    const integrated = new SttCompatController(undefined, sessionService as any, sessionBinding as any);

    const response = await integrated.stopSession({ size: 4 } as Express.Multer.File, {
      session_id: 'session_123456789',
      sample_rate: 44100,
      channels: 1,
      bit_depth: 16,
    });

    expect(sessionService.removeSession).toHaveBeenCalledWith('session_123456789');
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
});
