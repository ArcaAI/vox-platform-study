import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateUsageAttributes } from '../../../usageLedger/usage-attributes';
import { STT_GATEWAY_DEFAULTS, STT_SESSION_CREATE_TIMEOUT_MS_KEY } from '../../../settings-registry/descriptors/stt-gateway.descriptors';
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

    expect(httpService.get).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/availability',
      expect.objectContaining({ timeout: 5000 }),
    );
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

    expect(httpService.get).toHaveBeenCalledWith('http://localhost:8861/internal/streaming/availability', expect.objectContaining({ timeout: 5000 }));
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
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
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

    expect(httpService.get).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-2',
      expect.objectContaining({ timeout: 5000 }),
    );
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
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('switchProvider POSTs { target: "primary" } for a switch back', async () => {
    httpService.post.mockReturnValue(of({ data: { switched: true, active: 'primary' } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.switchProvider('s-5', 'primary');

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-5/switch',
      { target: 'primary' },
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('switchToFallback is a thin alias posting { target: "fallback" }', async () => {
    httpService.post.mockReturnValue(of({ data: { switched: true, active: 'fallback' } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.switchToFallback('s-6');

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions/s-6/switch',
      { target: 'fallback' },
      expect.objectContaining({ timeout: 5000 }),
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
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('forwards language_mode (snake_case) in createSession POST body', async () => {
    httpService.post.mockReturnValue(of({ data: { session_id: 's-7', status: 'active', max_concurrent: 4, current_active: 1 } }));

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
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('createSession sends language_mode: null when unset', async () => {
    httpService.post.mockReturnValue(of({ data: { session_id: 's-8', status: 'active', max_concurrent: 4, current_active: 1 } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({ sessionId: 's-8', tenantId: 'tenant-1', pipelineId: 'pipeline-1' });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ language_mode: null }),
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('TASK-891 — an end-user language DECLARATION travels beside the spec, not inside it', async () => {
    // OD-1: absent means "use the agent's mode", so the two facts are DIFFERENT
    // channels and both must survive the same POST:
    //   * `language_mode`             — what the end user / SDK declared;
    //   * `resolved_spec.decoding.languageMode` — what the AGENT declared.
    // apps/stt resolves the declaration against the engine that actually loads
    // and falls back to the spec's mode when nothing was declared. Overwriting
    // the spec with the declaration would erase the agent's own opinion from the
    // record the session is rebuilt from after a worker restart.
    httpService.post.mockReturnValue(of({ data: { session_id: 's-91', status: 'active', max_concurrent: 4, current_active: 1 } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({
      sessionId: 's-91',
      tenantId: 'tenant-1',
      pipelineId: 'runtime-key-1',
      languageMode: 'en',
      resolvedSpec: { models: {}, audioFrontEnd: { diarization: { enabled: false } }, decoding: { languageMode: 'ml-en' } } as never,
    });

    const body = httpService.post.mock.calls[0][1];
    expect(body.language_mode).toBe('en');
    expect(body.resolved_spec.decoding.languageMode).toBe('ml-en');
  });

  it('forwards start_on (snake_case) in createSession POST body', async () => {
    httpService.post.mockReturnValue(of({ data: { session_id: 's-9', status: 'active', max_concurrent: 4, current_active: 1 } }));

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
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('createSession sends start_on: null when unset', async () => {
    httpService.post.mockReturnValue(of({ data: { session_id: 's-10', status: 'active', max_concurrent: 4, current_active: 1 } }));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    await service.createSession({ sessionId: 's-10', tenantId: 'tenant-1', pipelineId: 'pipeline-1' });

    expect(httpService.post).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/sessions',
      expect.objectContaining({ start_on: null }),
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('getLanguageModes fetches the STT catalog', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          modes: [
            { id: 'en', label: 'English', kind: 'single', primaryLanguage: 'en', secondaryLanguage: null, supportedEngines: ['OPENAI'] },
            {
              id: 'ml-en',
              label: 'Malayalam + English',
              kind: 'code_switch',
              primaryLanguage: 'ml',
              secondaryLanguage: 'en',
              supportedEngines: ['SARVAM'],
            },
          ],
        },
      }),
    );

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.getLanguageModes();

    expect(httpService.get).toHaveBeenCalledWith(
      'http://stt.internal:9000/internal/streaming/language-modes',
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(result.modes.map((m) => m.id)).toEqual(['en', 'ml-en']);
  });

  it('getLanguageModes returns an empty catalog when STT is unreachable', async () => {
    httpService.get.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

    const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

    const result = await service.getLanguageModes();

    expect(result).toEqual({ modes: [] });
  });

  /**
   * The create response is the client's baseline.
   *
   * STT now echoes the RESOLVED pipeline and the engine it actually opened on
   * (`pipeline_id` / `active_engine`), which is the only honest source for the
   * SDK's `activePipeline`: a client that sent no pipelineId, a session opened
   * on the fallback by choice (`start_on`), and one opened there because the
   * primary ASR failed to load are all invisible to the request alone.
   */
  describe('createSession — server-derived pipeline baseline', () => {
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
   * The tenant's auto-switch governance must reach STT.
   *
   * `autoSwitchEnabled` and `consecutiveFailureThreshold` are stored on
   * `TenantSttConfig`, resolved by `resolveEffectiveSttConfig`, and returned by
   * the effective-config API — but nothing ever put them on this POST body, so
   * `EngineSwitchController` always used its own defaults. A tenant that turned
   * auto-fallback OFF still got auto-fallback.
   */
  describe('StreamingSessionService.createSession — auto-switch governance', () => {
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
        expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
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
        expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
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
        expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
      );
    });
  });

  // ===========================================================================
  // removeSession() usage emission
  // ===========================================================================
  describe('removeSession — transcribe.stream usage emission', () => {
    const teardownSummary = (overrides: Record<string, unknown> = {}) => ({
      session_id: 's-1',
      tenant_id: 'tenant-1',
      consultation_id: 'consult-1',
      user_id: 'doctor-1',
      pipeline_id: 'pipeline-9',
      closed_at: '2026-08-06T10:01:30',
      audio_seconds: 42.5,
      session_seconds: 90.0,
      engine: 'whisper_cpp',
      deployment: 'SELF_HOSTED',
      language_mode: 'ml-en',
      ...overrides,
    });

    const mockUsageLedgerService = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) });

    it('emits BOTH SESSION_SECOND and AUDIO_SECOND on a real (complete) teardown', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary() }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input).toMatchObject({
        common: expect.objectContaining({
          tenantId: 'tenant-1',
          sessionId: 's-1',
          consultationId: 'consult-1',
          doctorId: 'doctor-1',
          idempotencyKey: 'stt:session:s-1',
          occurredAt: '2026-08-06T10:01:30',
          capability: 'STT',
          operation: 'transcribe.stream',
          provider: 'whisper_cpp',
          model: null,
          deployment: 'SELF_HOSTED',
          attributesJson: expect.objectContaining({
            engine: 'whisper_cpp',
            pipelineId: 'pipeline-9',
            languageMode: 'ml-en',
            channelCount: 1,
            streamKind: 'ws',
            interrupted: false,
          }),
        }),
        units: expect.arrayContaining([
          { unit: 'SESSION_SECOND', quantity: 90.0 },
          { unit: 'AUDIO_SECOND', quantity: 42.5 },
        ]),
      });
      expect(input.common.costBasis).toBeUndefined();
    });

    it('stamps interrupted:true on the abort path — SAME idempotency key as completion', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary() }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1', true);

      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.idempotencyKey).toBe('stt:session:s-1');
      expect(input.common.attributesJson.interrupted).toBe(true);
    });

    it('maps a BYOK-deployed engine to costBasis BYOK_NOTIONAL', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary({ engine: 'azure-speech', deployment: 'BYOK' }) }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.provider).toBe('azure-speech');
      expect(input.common.deployment).toBe('BYOK');
      expect(input.common.costBasis).toBe('BYOK_NOTIONAL');
    });

    it('does NOT emit when the session had no resolved engine (never guesses a provider)', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary({ engine: null, deployment: null }) }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    it('does NOT emit on the idempotent 204 "already gone" response (no summary)', async () => {
      httpService.delete.mockReturnValue(of({ status: 204, data: undefined }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    it('does NOT emit and does NOT throw when the ledger itself is not wired', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary() }));
      // Exactly the 2-arg construction every existing caller uses.
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'));

      await expect(service.removeSession('s-1')).resolves.toBeUndefined();
    });

    it('still resolves (never throws) when recordUsage itself fails — metering never blocks teardown', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary() }));
      const usageLedgerService = { recordUsage: vi.fn().mockRejectedValue(new Error('ledger boom')) };
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await expect(service.removeSession('s-1')).resolves.toBeUndefined();
    });

    // TASK-874 — fallback to the platform default is a metered HA capability, so
    // a session that switched engines mid-flight bills ENGINE-TIME: one ledger row
    // per engine, each with the funding derived from the row that served it. The
    // whole-session-to-one-tier row is what mis-billed a BYO session that failed
    // over (and, the other way, a platform session that switched back).
    it('emits ONE ledger row per engine segment, each with its own engine/deployment/costBasis', async () => {
      httpService.delete.mockReturnValue(
        of({
          status: 200,
          data: teardownSummary({
            engine: 'whisper_cpp',
            deployment: 'SELF_HOSTED',
            segments: [
              { engine: 'azure-speech', deployment: 'BYOK', audio_seconds: 30.0, session_seconds: 60.0 },
              { engine: 'sarvam', deployment: 'CLOUD', audio_seconds: 12.5, session_seconds: 30.0 },
            ],
          }),
        }),
      );
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(2);
      const [byok] = usageLedgerService.recordUsage.mock.calls[0];
      const [cloud] = usageLedgerService.recordUsage.mock.calls[1];

      expect(byok.common.provider).toBe('azure-speech');
      expect(byok.common.deployment).toBe('BYOK');
      expect(byok.common.costBasis).toBe('BYOK_NOTIONAL');
      // The chronologically FIRST segment keeps the unchanged session key, so a
      // never-switching session emits a byte-identical row to before.
      expect(byok.common.idempotencyKey).toBe('stt:session:s-1');
      expect(byok.units).toEqual(
        expect.arrayContaining([
          { unit: 'SESSION_SECOND', quantity: 60.0 },
          { unit: 'AUDIO_SECOND', quantity: 30.0 },
        ]),
      );
      expect(byok.common.attributesJson).toMatchObject({ engine: 'azure-speech' });

      expect(cloud.common.provider).toBe('sarvam');
      expect(cloud.common.deployment).toBe('CLOUD');
      // Platform-funded fallback time is real COGS — never zeroed as BYOK_NOTIONAL.
      expect(cloud.common.costBasis).toBeUndefined();
      expect(cloud.common.idempotencyKey).toBe('stt:session:s-1:1');
      expect(cloud.units).toEqual(
        expect.arrayContaining([
          { unit: 'SESSION_SECOND', quantity: 30.0 },
          { unit: 'AUDIO_SECOND', quantity: 12.5 },
        ]),
      );
      expect(cloud.common.attributesJson).toMatchObject({ engine: 'sarvam' });
      // A rollup counts fail-overs from the rows themselves: same sessionId,
      // different provider. No new attributesJson key is needed (and none may be
      // added from this lane — the allow-list is a PHI boundary).
      expect(cloud.common.sessionId).toBe(byok.common.sessionId);
    });

    it('a single-segment summary (never switched) emits exactly the one legacy row and key', async () => {
      httpService.delete.mockReturnValue(
        of({
          status: 200,
          data: teardownSummary({ segments: [{ engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 42.5, session_seconds: 90.0 }] }),
        }),
      );
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.idempotencyKey).toBe('stt:session:s-1');
      expect(input.common.provider).toBe('whisper_cpp');
      expect(input.units).toEqual(
        expect.arrayContaining([
          { unit: 'SESSION_SECOND', quantity: 90.0 },
          { unit: 'AUDIO_SECOND', quantity: 42.5 },
        ]),
      );
    });

    it('an older STT that sends no segments still meters from the top-level fields (backward compatible)', async () => {
      httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary() }));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.idempotencyKey).toBe('stt:session:s-1');
      expect(input.common.provider).toBe('whisper_cpp');
      expect(input.common.attributesJson.engine).toBe('whisper_cpp');
    });

    it('drops a zero-duration segment rather than billing an engine that never served', async () => {
      httpService.delete.mockReturnValue(
        of({
          status: 200,
          data: teardownSummary({
            segments: [
              { engine: 'azure-speech', deployment: 'BYOK', audio_seconds: 0, session_seconds: 0 },
              { engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 42.5, session_seconds: 90.0 },
            ],
          }),
        }),
      );
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.provider).toBe('whisper_cpp');
      expect(input.common.idempotencyKey).toBe('stt:session:s-1');
    });

    // `attributesJson` is a closed PHI allow-list, and an undeclared key is
    // REJECTED by `recordUsage` (ArgumentInvalidException — nothing written), not
    // dropped. A mocked ledger cannot see that, so run the real validator over
    // what this emitter actually builds.
    it('every emitted attributesJson bag passes the usage-ledger allow-list', async () => {
      httpService.delete.mockReturnValue(
        of({
          status: 200,
          data: teardownSummary({
            segments: [
              { engine: 'azure-speech', deployment: 'BYOK', audio_seconds: 30.0, session_seconds: 60.0 },
              { engine: 'sarvam', deployment: 'CLOUD', audio_seconds: 12.5, session_seconds: 30.0 },
            ],
          }),
        }),
      );
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await service.removeSession('s-1');

      expect(usageLedgerService.recordUsage.mock.calls).toHaveLength(2);
      for (const [input] of usageLedgerService.recordUsage.mock.calls) {
        expect(validateUsageAttributes(input.common.attributesJson)).toEqual([]);
      }
    });

    it('a genuine 404 from STT still resolves without attempting emission (pre-existing idempotent-removal behaviour)', async () => {
      httpService.delete.mockReturnValue(throwError(() => ({ response: { status: 404 } })));
      const usageLedgerService = mockUsageLedgerService();
      const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

      await expect(service.removeSession('s-1')).resolves.toBeUndefined();
      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    // =========================================================================
    // TASK-959 §3.2/§4.2 — compute and network, PER SEGMENT
    //
    // `cumulative_processing_seconds` was read once at teardown for a Prometheus
    // RTF gauge and then dropped. Per segment it becomes billable, and per
    // segment is the only grain that works: a cloud leg occupied this service's
    // CPU waiting on the vendor while the self-hosted leg of the same session
    // held a real accelerator, so the two legs bill DIFFERENT units.
    // =========================================================================
    describe('compute + network per segment (TASK-959)', () => {
      const emit = async (segments: unknown[]) => {
        httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary({ segments }) }));
        const usageLedgerService = mockUsageLedgerService();
        const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);
        await service.removeSession('s-1');
        return usageLedgerService.recordUsage.mock.calls.map(([input]: any[]) => input);
      };

      /** `UsageSegment.to_dict()` for a BYOK cloud leg — bytes measured on the wire. */
      const cloudLeg = {
        engine: 'sarvam',
        deployment: 'BYOK',
        audio_seconds: 20.0,
        session_seconds: 60.0,
        connection_id: 'conn-1',
        processing_seconds: 4.0,
        device: 'cpu',
        request_bytes: 4096,
        response_bytes: 512,
        byte_source: 'wire',
      };

      /** …and for a self-hosted GPU leg: real accelerator, NULL bytes (no such call). */
      const selfHostedLeg = {
        engine: 'whisper_cpp',
        deployment: 'SELF_HOSTED',
        audio_seconds: 22.5,
        session_seconds: 30.0,
        connection_id: null,
        processing_seconds: 11.25,
        device: 'cuda',
        request_bytes: null,
        response_bytes: null,
        byte_source: null,
      };

      it('bills each leg of a switched session its OWN unit — cloud CPU, self-hosted GPU', async () => {
        const calls = await emit([cloudLeg, selfHostedLeg]);

        // Three batches: the BYOK leg splits its CPU row onto the INTERNAL basis.
        expect(calls).toHaveLength(3);
        const [byokVendor, byokPlatform, selfHosted] = calls;

        expect(byokVendor.common.idempotencyKey).toBe('stt:session:s-1');
        expect(byokVendor.common.costBasis).toBe('BYOK_NOTIONAL');
        expect(byokVendor.units).toEqual([
          { unit: 'SESSION_SECOND', quantity: 60.0 },
          { unit: 'AUDIO_SECOND', quantity: 20.0 },
          { unit: 'EGRESS_BYTE', quantity: '4096', attributesJson: { byteSource: 'wire' } },
          { unit: 'INGRESS_BYTE', quantity: '512', attributesJson: { byteSource: 'wire' } },
        ]);

        // The CPU this service burned calling the tenant's vendor is the
        // PLATFORM's cost — same base key, INTERNAL basis, connection preserved.
        expect(byokPlatform.common.idempotencyKey).toBe('stt:session:s-1');
        expect(byokPlatform.common.costBasis).toBe('INTERNAL');
        expect(byokPlatform.common.connectionId).toBe('conn-1');
        expect(byokPlatform.units).toEqual([{ unit: 'CPU_SECOND', quantity: '4.000', attributesJson: { device: 'cpu' } }]);

        // The self-hosted leg keeps its own ordinal key, its own device, and no
        // byte rows at all — `null` is "no third-party call", not a zero.
        expect(selfHosted.common.idempotencyKey).toBe('stt:session:s-1:1');
        expect(selfHosted.common.costBasis).toBeUndefined();
        expect(selfHosted.units).toEqual([
          { unit: 'SESSION_SECOND', quantity: 30.0 },
          { unit: 'AUDIO_SECOND', quantity: 22.5 },
          { unit: 'GPU_SECOND', quantity: '11.250', attributesJson: { device: 'cuda' } },
        ]);
      });

      it('emits no compute row for a RECOVERED session — 0.0 seconds on the default device', async () => {
        // A crash-restarted session keeps no accumulator, so `to_dict` reports
        // `processing_seconds: 0.0, device: "cpu"`. Billing a zero-second CPU row
        // would put a priceable-looking row on a session nobody measured.
        const calls = await emit([
          {
            engine: 'whisper_cpp',
            deployment: 'SELF_HOSTED',
            audio_seconds: 42.5,
            session_seconds: 90.0,
            connection_id: null,
            processing_seconds: 0.0,
            device: 'cpu',
            request_bytes: null,
            response_bytes: null,
            byte_source: null,
          },
        ]);

        expect(calls).toHaveLength(1);
        expect(calls[0].units).toEqual([
          { unit: 'SESSION_SECOND', quantity: 90.0 },
          { unit: 'AUDIO_SECOND', quantity: 42.5 },
        ]);
      });

      it('emits no compute row for a segment from an STT that predates the fields', async () => {
        const calls = await emit([{ engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 42.5, session_seconds: 90.0 }]);

        expect(calls[0].units).toEqual([
          { unit: 'SESSION_SECOND', quantity: 90.0 },
          { unit: 'AUDIO_SECOND', quantity: 42.5 },
        ]);
      });

      it('ignores a device spelling the ledger does not price — the DELETE path is unvalidated', async () => {
        // `removeSession` reads the STT response body with no ValidationPipe in
        // front of it (only the reaper push-back goes through a DTO), so the
        // helper is the enforcement point. A `gpu` here must not become a
        // GPU_SECOND by string luck, nor a CPU_SECOND by falling through.
        const calls = await emit([{ ...selfHostedLeg, device: 'gpu' }]);

        expect(calls[0].units.map((u: any) => u.unit)).toEqual(['SESSION_SECOND', 'AUDIO_SECOND']);
      });

      it('a CLOUD leg needs no split — its batch is already INTERNAL', async () => {
        const calls = await emit([{ ...cloudLeg, deployment: 'CLOUD', connection_id: null }]);

        expect(calls).toHaveLength(1);
        expect(calls[0].common.costBasis).toBeUndefined();
        expect(calls[0].units).toContainEqual({ unit: 'CPU_SECOND', quantity: '4.000', attributesJson: { device: 'cpu' } });
      });

      it('every attributesJson bag it builds — common AND per-unit — passes the allow-list', async () => {
        // `recordUsage` REJECTS an undeclared key (nothing written), and a per-unit
        // bag is merged over the common one at expansion, so both must pass.
        const calls = await emit([cloudLeg, selfHostedLeg]);

        for (const input of calls) {
          expect(validateUsageAttributes(input.common.attributesJson)).toEqual([]);
          for (const unit of input.units) {
            expect(validateUsageAttributes({ ...input.common.attributesJson, ...(unit.attributesJson ?? {}) })).toEqual([]);
          }
        }
      });

      it('still resolves when the second (INTERNAL-basis) emission throws', async () => {
        httpService.delete.mockReturnValue(of({ status: 200, data: teardownSummary({ segments: [cloudLeg] }) }));
        const usageLedgerService = {
          recordUsage: vi.fn().mockResolvedValueOnce({ outboxIds: ['o-1'], events: 4 }).mockRejectedValueOnce(new Error('ledger boom')),
        };
        const service = new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), usageLedgerService as any);

        await expect(service.removeSession('s-1')).resolves.toBeUndefined();
      });
    });
  });
});

/**
 * TASK-887 — the gateway resolves the session user's ENROLLED voice profiles and pushes them.
 *
 * `apps/stt` holds no database connection on the agent path, and only the gateway knows the
 * session's user, its tenant, and the model the agent bound — so it is the only side that can
 * filter profiles to the space that will actually match them.
 */
describe('StreamingSessionService — voice profiles ride the create body', () => {
  const configWithSttUrl = (url?: string): any => ({ config: { STT_URL: url } });
  const created = () => of({ data: { session_id: 's-vp', status: 'active', max_concurrent: 4, current_active: 1 } });

  const specWith = (opts: { enabled: boolean; embeddingSlug?: string }): any => ({
    models: { asr: { slug: 'whisper' }, ...(opts.embeddingSlug ? { embedding: { slug: opts.embeddingSlug } } : {}) },
    audioFrontEnd: { diarization: { enabled: opts.enabled } },
  });

  const build = (voiceProfileService?: unknown) =>
    new StreamingSessionService(
      httpServiceRef.current,
      configWithSttUrl('http://stt.internal:9000'),
      undefined,
      undefined,
      voiceProfileService as never,
    );

  const httpServiceRef: { current: any } = { current: null };
  beforeEach(() => {
    vi.clearAllMocks();
    httpServiceRef.current = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  });

  const openSession = async (voiceProfileService: unknown, resolvedSpec: unknown) => {
    httpServiceRef.current.post.mockReturnValue(created());
    await build(voiceProfileService).createSession({
      sessionId: 's-vp',
      tenantId: 'tenant-1',
      pipelineId: 'agent-version-1',
      userId: 'user-1',
      resolvedSpec: resolvedSpec as never,
    });
    return httpServiceRef.current.post.mock.calls[0][1] as Record<string, unknown>;
  };

  it('pushes the user’s profiles for the agent’s embedding model', async () => {
    const listForRuntime = vi.fn().mockResolvedValue([{ profile_id: 'vp-1', label: 'Dr Who', model_id: 'ecapa-tdnn-voxceleb', embedding: [0.1] }]);
    const body = await openSession({ listForRuntime }, specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }));

    expect(listForRuntime).toHaveBeenCalledWith('user-1', 'tenant-1', 'ecapa-tdnn-voxceleb');
    expect(body.voice_profiles).toEqual([{ profile_id: 'vp-1', label: 'Dr Who', model_id: 'ecapa-tdnn-voxceleb', embedding: [0.1] }]);
  });

  it('resolves nothing when diarization is off — the OFF default costs no query', async () => {
    const listForRuntime = vi.fn();
    const body = await openSession({ listForRuntime }, specWith({ enabled: false, embeddingSlug: 'ecapa-tdnn-voxceleb' }));

    expect(listForRuntime).not.toHaveBeenCalled();
    expect(body.voice_profiles).toBeNull();
  });

  it('resolves nothing when the agent bound no embedding model', async () => {
    const listForRuntime = vi.fn();
    const body = await openSession({ listForRuntime }, specWith({ enabled: true }));

    expect(listForRuntime).not.toHaveBeenCalled();
    expect(body.voice_profiles).toBeNull();
  });

  it('sends null rather than an empty list when the user has enrolled nothing', async () => {
    // One encoding of one state: `apps/stt` reads absence as "diarize generically".
    const body = await openSession(
      { listForRuntime: vi.fn().mockResolvedValue([]) },
      specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }),
    );
    expect(body.voice_profiles).toBeNull();
  });

  it('opens the session unchanged when no voice-profile service is wired', async () => {
    const body = await openSession(undefined, specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }));
    expect(body.voice_profiles).toBeNull();
    expect(body.session_id).toBe('s-vp');
  });
});

/**
 * TASK-890 L11 (§3.13) — `monthlySttSessionSeconds` was RECORDED at teardown
 * (`emitStreamingUsage`) and never CHECKED anywhere. A tenant past its live-
 * transcription allowance could open sessions indefinitely and only discover
 * the overrun on its invoice, which is the opposite of what an allowance is.
 *
 * The check belongs at session OPEN: that is the only moment where refusing
 * costs nothing. Refusing at teardown would bill the work and then complain.
 */
describe('StreamingSessionService — the live-session allowance (TASK-890)', () => {
  const config: any = { config: { STT_URL: 'http://stt.internal:9000' } };
  const dto: any = { sessionId: 's-1', tenantId: 'tenant-1', consultationId: 'c-1' };

  function makeHttp() {
    return {
      get: vi.fn(),
      delete: vi.fn(),
      post: vi.fn().mockReturnValue(of({ data: { session_id: 's-1', status: 'ready' } })),
    } as any;
  }

  it('prechecks the session allowance for the SESSION tenant, before opening on STT', async () => {
    const http = makeHttp();
    const entitlements = { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
    const service = new StreamingSessionService(http, config, undefined, undefined, undefined, entitlements as any);

    await service.createSession(dto);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('tenant-1', 'monthlySttSessionSeconds');
    expect(entitlements.assertMeterQuota.mock.invocationCallOrder[0]).toBeLessThan(http.post.mock.invocationCallOrder[0]);
  });

  it('refuses to open a session on an exhausted allowance — STT is never asked', async () => {
    const http = makeHttp();
    const entitlements = { assertMeterQuota: vi.fn().mockRejectedValue(new Error('over allowance')) };
    const service = new StreamingSessionService(http, config, undefined, undefined, undefined, entitlements as any);

    await expect(service.createSession(dto)).rejects.toThrow('over allowance');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('opens normally when no entitlements service is wired (metering is additive)', async () => {
    const http = makeHttp();
    const service = new StreamingSessionService(http, config);
    await expect(service.createSession(dto)).resolves.toMatchObject({ status: 'ready' });
  });
});
