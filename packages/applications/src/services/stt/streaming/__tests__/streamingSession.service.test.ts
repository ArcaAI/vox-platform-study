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

  it('switchProvider POSTs { target: "fallback" } to the switch route', async () => {
    httpService.post.mockReturnValue(of({ data: { switched: true, active: 'fallback' } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.switchProvider('s-4', 'fallback');

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-4/switch',
      { target: 'fallback' },
      { timeout: 5000 },
    );
  });

  it('switchProvider POSTs { target: "primary" } for a switch back', async () => {
    httpService.post.mockReturnValue(of({ data: { switched: true, active: 'primary' } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.switchProvider('s-5', 'primary');

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-5/switch',
      { target: 'primary' },
      { timeout: 5000 },
    );
  });

  it('switchToFallback is a thin alias posting { target: "fallback" }', async () => {
    httpService.post.mockReturnValue(of({ data: { switched: true, active: 'fallback' } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.switchToFallback('s-6');

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-6/switch',
      { target: 'fallback' },
      { timeout: 5000 },
    );
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

  it('forwards language_mode (snake_case) in createSession POST body (TASK-587)', async () => {
    httpService.post.mockReturnValue(
      of({ data: { session_id: 's-7', status: 'active', max_concurrent: 4, current_active: 1 } }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({
      sessionId: 's-7',
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      languageMode: 'ml-en',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ language_mode: 'ml-en' }),
      { timeout: 15000 },
    );
  });

  it('createSession sends language_mode: null when unset (TASK-587)', async () => {
    httpService.post.mockReturnValue(
      of({ data: { session_id: 's-8', status: 'active', max_concurrent: 4, current_active: 1 } }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({ sessionId: 's-8', tenantId: 'tenant-1', pipelineId: 'pipeline-1' });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ language_mode: null }),
      { timeout: 15000 },
    );
  });

  it('forwards start_on (snake_case) in createSession POST body (TASK-586 C8)', async () => {
    httpService.post.mockReturnValue(
      of({ data: { session_id: 's-9', status: 'active', max_concurrent: 4, current_active: 1 } }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({
      sessionId: 's-9',
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      startOn: 'fallback',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ start_on: 'fallback' }),
      { timeout: 15000 },
    );
  });

  it('createSession sends start_on: null when unset (TASK-586 C8)', async () => {
    httpService.post.mockReturnValue(
      of({ data: { session_id: 's-10', status: 'active', max_concurrent: 4, current_active: 1 } }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({ sessionId: 's-10', tenantId: 'tenant-1', pipelineId: 'pipeline-1' });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ start_on: null }),
      { timeout: 15000 },
    );
  });

  it('getLanguageModes fetches the STT catalog (TASK-587)', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          modes: [
            { id: 'en', label: 'English', kind: 'single', primaryLanguage: 'en', secondaryLanguage: null, supportedEngines: ['OPENAI'] },
            { id: 'ml-en', label: 'Malayalam + English', kind: 'code_switch', primaryLanguage: 'ml', secondaryLanguage: 'en', supportedEngines: ['SARVAM'] },
          ],
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.getLanguageModes();

    expect(httpService.get).toHaveBeenCalledWith('http://stt.internal:9000/internal/streaming/language-modes', { timeout: 5000 });
    expect(result.modes.map((m) => m.id)).toEqual(['en', 'ml-en']);
  });

  it('getLanguageModes returns an empty catalog when STT is unreachable (TASK-587)', async () => {
    httpService.get.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.getLanguageModes();

    expect(result).toEqual({ modes: [] });
  });

  /**
   * TASK-614 D-5 / AC-2 — the create response is the client's baseline.
   *
   * STT now echoes the RESOLVED pipeline and the engine it actually opened on
   * (`pipeline_id` / `active_engine`), which is the only honest source for the
   * SDK's `activePipeline`: a client that sent no pipelineId, a session opened
   * on the fallback by choice (`start_on`), and one opened there because the
   * primary ASR failed to load are all invisible to the request alone.
   */
  describe('createSession — server-derived pipeline baseline (TASK-614)', () => {
    it('maps pipeline_id and active_engine from the STT response', async () => {
      httpService.post.mockReturnValue(
        of({
          data: {
            session_id: 's-10',
            status: 'active',
            max_concurrent: 4,
            current_active: 1,
            pipeline_id: 'resolved-pipe',
            active_engine: 'fallback',
          },
        }),
      );
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      const result = await service.createSession({ sessionId: 's-10', tenantId: 'tenant-1', pipelineId: 'requested-pipe' });

      expect(result?.pipelineId).toBe('resolved-pipe');
      expect(result?.activeEngine).toBe('fallback');
    });

    it('leaves both undefined against an older STT that echoes neither', async () => {
      // Mixed-version degrade: a new gateway must not invent a baseline.
      httpService.post.mockReturnValue(of({ data: { session_id: 's-11', status: 'active', max_concurrent: 4, current_active: 1 } }));
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      const result = await service.createSession({ sessionId: 's-11', tenantId: 'tenant-1', pipelineId: 'requested-pipe' });

      expect(result?.pipelineId).toBeUndefined();
      expect(result?.activeEngine).toBeUndefined();
    });
  });

  /**
   * TASK-614 D-10 — the tenant's auto-switch governance must reach STT.
   *
   * `autoSwitchEnabled` and `consecutiveFailureThreshold` are stored on
   * `TenantSttConfig`, resolved by `resolveEffectiveSttConfig`, and returned by
   * the effective-config API — but nothing ever put them on this POST body, so
   * `EngineSwitchController` always used its own defaults. A tenant that turned
   * auto-fallback OFF still got auto-fallback.
   */
  describe('StreamingSessionService.createSession — auto-switch governance (TASK-614)', () => {
    const okResponse = () => of({ data: { session_id: 's-9', status: 'active', max_concurrent: 4, current_active: 1 } });

    it('forwards auto_switch_enabled and consecutive_failure_threshold', async () => {
      httpService.post.mockReturnValue(okResponse());
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      await service.createSession({
        sessionId: 's-9',
        tenantId: 'tenant-1',
        pipelineId: 'pipeline-1',
        autoSwitchEnabled: false,
        consecutiveFailureThreshold: 4,
      });

      expect(httpService.post).toHaveBeenCalledWith(
        'http://stt.internal:9000/internal/streaming/sessions',
        expect.objectContaining({ auto_switch_enabled: false, consecutive_failure_threshold: 4 }),
        { timeout: 15000 },
      );
    });

    it('sends null for both when the caller resolved neither', async () => {
      // Null, not omitted: STT reads `None` as "use the controller default", which
      // is exactly what an unresolved tenant setting means.
      httpService.post.mockReturnValue(okResponse());
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      await service.createSession({ sessionId: 's-9', tenantId: 'tenant-1', pipelineId: 'pipeline-1' });

      expect(httpService.post).toHaveBeenCalledWith(
        'http://stt.internal:9000/internal/streaming/sessions',
        expect.objectContaining({ auto_switch_enabled: null, consecutive_failure_threshold: null }),
        { timeout: 15000 },
      );
    });

    it('forwards auto_switch_enabled: true explicitly (never collapsed to null)', async () => {
      // `false` and `true` are both real tenant choices; a truthiness guard here
      // would silently drop the enabling one on a tenant that set it explicitly.
      httpService.post.mockReturnValue(okResponse());
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      await service.createSession({ sessionId: 's-9', tenantId: 'tenant-1', pipelineId: 'pipeline-1', autoSwitchEnabled: true });

      expect(httpService.post).toHaveBeenCalledWith(
        'http://stt.internal:9000/internal/streaming/sessions',
        expect.objectContaining({ auto_switch_enabled: true }),
        { timeout: 15000 },
      );
    });
  });
});
