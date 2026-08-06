import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { IConfigService } from '../../baseServices/_meta/config';
import { IStreamingSessionService } from './IStreamingSessionService';
import { CreateStreamingSessionRequest, SttLanguageModeCatalog, StreamingAvailability, StreamingSessionStatus } from './dto';

/**
 * StreamingSessionService
 *
 * Manages streaming session lifecycle by communicating with the STT
 * internal API endpoints:
 * - GET  /internal/streaming/availability
 * - POST /internal/streaming/sessions
 * - GET  /internal/streaming/sessions/{sessionId}
 * - DELETE /internal/streaming/sessions/{sessionId}
 *
 * This is a brand-new service for STT WebSocket streaming.
 * It does NOT touch or reuse the old STT v1 WebSocket implementation.
 */
@Injectable()
export class StreamingSessionService implements IStreamingSessionService {
  private readonly logger = new Logger(StreamingSessionService.name);
  private readonly sttBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
  ) {
    this.sttBaseUrl = this.configService?.config?.STT_URL || 'http://localhost:8861';
    this.logger.log({
      message: 'StreamingSessionService initialized',
      sttBaseUrl: this.sttBaseUrl,
    });
  }

  /**
   * Check if the STT streaming module is available and has capacity.
   */
  async checkAvailability(): Promise<StreamingAvailability> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<StreamingAvailability>(`${this.sttBaseUrl}/internal/streaming/availability`, { timeout: 5000 }),
      );
      return data;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to check streaming availability',
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        available: false,
        status: 'unreachable',
        maxConcurrent: 0,
        currentActive: 0,
        availableSlots: 0,
      };
    }
  }

  /**
   * Fetch the STT language-mode catalog + per-mode supported engines (TASK-587).
   *
   * Backend-authoritative source of truth for the SDK picker. The catalog is
   * static, so a short timeout + a safe empty fallback keep this read cheap and
   * non-fatal when STT is briefly unreachable.
   */
  async getLanguageModes(): Promise<SttLanguageModeCatalog> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<SttLanguageModeCatalog>(`${this.sttBaseUrl}/internal/streaming/language-modes`, { timeout: 5000 }),
      );
      return { modes: data?.modes ?? [] };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to fetch STT language modes',
        error: error instanceof Error ? error.message : String(error),
      });
      return { modes: [] };
    }
  }

  /**
   * Create a new streaming session on STT.
   *
   * @returns Session status, or null if at capacity (503)
   */
  async createSession(dto: CreateStreamingSessionRequest): Promise<StreamingSessionStatus | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<StreamingSessionStatus>(
          `${this.sttBaseUrl}/internal/streaming/sessions`,
          {
            session_id: dto.sessionId,
            tenant_id: dto.tenantId,
            pipeline_id: dto.pipelineId,
            consultation_id: dto.consultationId,
            sample_rate: dto.sampleRate ?? 16000,
            microphone_id: dto.microphoneId,
            user_id: dto.userId,
            language: dto.language ?? null,
            // End-user language mode (TASK-587); STT resolves it against the
            // session engine and 422s a mode no configured engine can serve.
            language_mode: dto.languageMode ?? null,
            // Pre-start default-provider selection (TASK-586 C8). STT opens the
            // session on the fallback engine when 'fallback' and a fallback is
            // configured; otherwise proceeds on primary (fail-open).
            start_on: dto.startOn ?? null,
            audio_bucket_name: dto.audioBucketName,
            // Per-tenant storage descriptor (DEDICATED tenants only; null/omitted
            // for SHARED). snake_case keys already match the Python worker schema.
            storage: dto.storage ?? null,
            // Per-tenant BYO provider credentials + fallback pointer (TASK-567).
            // Held by the session runtime in memory only; NEVER logged.
            provider_overrides: dto.providerOverrides ?? null,
            fallback_pipeline_id: dto.fallbackPipelineId ?? null,
            // Tenant governance for the FAILURE-DRIVEN auto switch (TASK-614).
            // Both are real `TenantSttConfig` settings that were resolved by the
            // gateway and then dropped here, so STT's EngineSwitchController
            // always used its own defaults — a tenant that disabled
            // auto-fallback still got it. `null` means "use the controller
            // default"; `?? null` (not a truthiness guard) so an explicit
            // `false` survives.
            auto_switch_enabled: dto.autoSwitchEnabled ?? null,
            consecutive_failure_threshold: dto.consecutiveFailureThreshold ?? null,
          },
          { timeout: 15000 },
        ),
      );

      this.logger.log({
        message: 'Streaming session created',
        sessionId: dto.sessionId,
        status: data.status,
      });

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionId: data.sessionId ?? (data as any).session_id,
        status: data.status,
        reason: data.reason,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        maxConcurrent: data.maxConcurrent ?? (data as any).max_concurrent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        currentActive: data.currentActive ?? (data as any).current_active,
        // The RESOLVED pipeline + the engine STT actually opened on (TASK-614).
        // This is the client's only honest baseline: the request carries what
        // was ASKED for, which differs from what runs whenever the caller sent
        // no pipelineId, chose `startOn: 'fallback'`, or the primary ASR failed
        // to load at create. Left undefined against an older STT that echoes
        // neither — a new gateway must not invent a baseline.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pipelineId: data.pipelineId ?? (data as any).pipeline_id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeEngine: data.activeEngine ?? (data as any).active_engine,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // 503 = at capacity → return null (not an error)
      if (error?.response?.status === 503) {
        this.logger.warn({
          message: 'STT streaming at capacity',
          sessionId: dto.sessionId,
          detail: error.response?.data?.detail,
        });
        return null;
      }

      this.logger.error({
        message: 'Failed to create streaming session',
        sessionId: dto.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the status of an existing streaming session.
   */
  async getSessionStatus(sessionId: string): Promise<StreamingSessionStatus | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<StreamingSessionStatus>(`${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`, { timeout: 5000 }),
      );

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionId: data.sessionId ?? (data as any).session_id,
        status: data.status,
        reason: data.reason,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        maxConcurrent: data.maxConcurrent ?? (data as any).max_concurrent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        currentActive: data.currentActive ?? (data as any).current_active,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Trigger a mid-session engine switch (TASK-567 R4, TASK-586).
   *
   * Bidirectional for user-initiated switches: POSTs `{ target }` to the apps/stt
   * internal switch route, which XADDs a `SWITCH_TO_FALLBACK` control message
   * (carrying the target) onto the session's control stream; the in-session
   * `EngineSwitchController` performs the seamless engine swap. 404 (unknown
   * session) and 409 (target unavailable — no fallback, primary never loaded, or
   * already on that engine) are surfaced to the caller.
   */
  async switchProvider(sessionId: string, target: 'primary' | 'fallback'): Promise<void> {
    await firstValueFrom(this.httpService.post(`${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}/switch`, { target }, { timeout: 5000 }));
    this.logger.log({ message: 'Streaming session engine switch requested', sessionId, target });
  }

  /**
   * Back-compat alias for `switchProvider(sessionId, 'fallback')` (TASK-567 native path).
   */
  async switchToFallback(sessionId: string): Promise<void> {
    await this.switchProvider(sessionId, 'fallback');
  }

  /**
   * Remove a streaming session (triggers finalization on STT).
   */
  async removeSession(sessionId: string): Promise<void> {
    try {
      await firstValueFrom(this.httpService.delete(`${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`, { timeout: 30000 }));

      this.logger.log({
        message: 'Streaming session removed',
        sessionId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error?.response?.status === 404) {
        this.logger.debug({
          message: 'Session already removed',
          sessionId,
        });
        return;
      }
      throw error;
    }
  }
}
