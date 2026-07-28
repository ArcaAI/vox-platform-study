import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streamingSession.service';

describe('StreamingSessionService', () => {
  let httpService: any;

  const configWithSttUrl = (url?: string): any => ({
    config: {
      STT_URL: url,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    httpService = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    };
  });

  it('uses STT_URL when checking availability', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          available: true,
          status: 'ready',
          maxConcurrent: 8,
          currentActive: 3,
          availableSlots: 5,
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.checkAvailability();

    expect(httpService.get).toHaveBeenCalledWith('http://stt.internal:9000/internal/streaming/availability', { timeout: 5000 });
  });

  it('falls back to localhost when STT_URL is missing', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          available: true,
          status: 'ready',
          maxConcurrent: 8,
          currentActive: 3,
          availableSlots: 5,
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl(undefined));

    await service.checkAvailability();

    expect(httpService.get).toHaveBeenCalledWith('http://localhost:8861/internal/streaming/availability', { timeout: 5000 });
  });

  it('returns null when createSession gets 503 at capacity', async () => {
    httpService.post.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: { detail: 'at_capacity' },
        },
      })),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.createSession({
      sessionId: 's-1',
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      sampleRate: 16000,
      userId: 'user-1',
    });

    expect(result).toBeNull();
    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({
        session_id: 's-1',
        tenant_id: 'tenant-1',
        pipeline_id: 'pipeline-1',
        sample_rate: 16000,
        user_id: 'user-1',
      }),
      { timeout: 15000 },
    );
  });

  it('maps snake_case fields when reading session status', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          session_id: 's-2',
          status: 'active',
          max_concurrent: 4,
          current_active: 2,
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.getSessionStatus('s-2');

    expect(httpService.get).toHaveBeenCalledWith('http://stt.internal:9000/internal/streaming/sessions/s-2', { timeout: 5000 });
    expect(result).toEqual({
      sessionId: 's-2',
      status: 'active',
      reason: undefined,
      maxConcurrent: 4,
      currentActive: 2,
    });
  });

  it('forwards audio_bucket_name in createSession POST body when provided', async () => {
    httpService.post.mockReturnValue(
      of({
        data: {
          session_id: 's-3',
          status: 'active',
          max_concurrent: 4,
          current_active: 1,
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({
      sessionId: 's-3',
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      audioBucketName: 'hope-audio-arcaai',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({
        audio_bucket_name: 'hope-audio-arcaai',
      }),
      { timeout: 15000 },
    );
  });
});
