import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { IConfigService } from '../../baseServices/_meta/config';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IUsageLedgerService, UsageIdempotencyKey } from '../../usageLedger';
import { TENANTLESS, TenantlessReason, internalServiceHeaders, resolveInternalAccessToken } from '../../../common';
import { IStreamingSessionService } from './IStreamingSessionService';
import {
  CreateStreamingSessionRequest,
  SttLanguageModeCatalog,
  StreamingAvailability,
  StreamingSessionStatus,
  StreamingSessionTeardownSummary,
} from './dto';

/**
 * Declared reason for the session-scoped hops that legitimately hold no tenant.
 *
 * Session teardown is reached from three background paths that carry only a
 * session id — the SIGTERM/rolling-deploy sweep in `SttWsGateway`, the Redis
 * `stt:session-removal:retry` set drained by `SessionRemovalRetryService`, and
 * the compat gateway's disconnect handler. Their envelopes have no tenant
 * column, which is exactly `TENANTLESS.JOB_QUEUE`. Every caller that DOES hold
 * a tenant threads it explicitly — declaring tenant-less-ness with a tenant one
 * line above is the failure this contract exists to prevent.
 */
const SESSION_TENANTLESS_REASON = TENANTLESS.JOB_QUEUE;

/**
 * StreamingSessionService
 *
 * Manages streaming session lifecycle by communicating with the STT
 * internal API endpoints:
 * - GET /internal/streaming/availability
 * - POST /internal/streaming/sessions
 * - GET /internal/streaming/sessions/{sessionId}
 * - DELETE /internal/streaming/sessions/{sessionId}
 *
 * This is a brand-new service for STT WebSocket streaming.
 * It does NOT touch or reuse the old STT v1 WebSocket implementation.
 *
 * This is also the ONE emission point for the
 * `transcribe.stream` usage-ledger row. Every caller (the DELETE controller
 * route, the WS gateway's disconnect/finalize/shutdown paths, the removal
 * retry service, and the stt-compat surface) tears a session down through
 * `removeSession`, so putting emission here — rather than duplicating it per
 * caller — guarantees they all flow through the same path.
 */
@Injectable()
export class StreamingSessionService implements IStreamingSessionService {
  private readonly logger = new Logger(StreamingSessionService.name);
  private readonly sttBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    // Optional + trailing so every existing 2-arg construction (tests,
    // and any DI graph that doesn't wire the ledger) keeps compiling —
    // emission is simply skipped when this is absent.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
    // Optional + trailing so every existing positional construction keeps
    // compiling. `apps/stt` now runs `ServiceAuthMiddleware`, so an unwired
    // secrets service means an EMPTY token — sent anyway, and rejected by stt,
    // rather than the hop silently downgrading to unauthenticated HTTP.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.sttBaseUrl = this.configService?.config?.STT_URL || 'http://localhost:8861';
    this.logger.log({
      message: 'StreamingSessionService initialized',
      sttBaseUrl: this.sttBaseUrl,
    });
  }

  /**
   * Build the `X-Service-Token` + `X-Tenant-Id` pair for one hop to stt.
   *
   * D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (there has never been an
   * `STT_SERVICE_TOKEN` — `platform-secrets.descriptors.ts` says so explicitly —
   * so the legacy key is passed only to satisfy the shared resolver's signature
   * and never resolves to anything).
   */
  private async sttHeaders(tenantId: string | null | undefined, tenantlessReason: TenantlessReason): Promise<Record<string, string>> {
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    return internalServiceHeaders({ serviceToken, tenantId, tenantlessReason });
  }

  /**
   * Check if the STT streaming module is available and has capacity.
   *
   * A platform capability probe: it asks the STT process about its own
   * capacity, not about any tenant's work, so it DECLARES itself tenant-less
   * rather than borrowing a caller's tenant.
   */
  async checkAvailability(): Promise<StreamingAvailability> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<StreamingAvailability>(`${this.sttBaseUrl}/internal/streaming/availability`, {
          timeout: 5000,
          headers: await this.sttHeaders(null, TENANTLESS.CONTROL_PLANE),
        }),
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
   * Fetch the STT language-mode catalog + per-mode supported engines.
   *
   * Backend-authoritative source of truth for the SDK picker. The catalog is
   * static, so a short timeout + a safe empty fallback keep this read cheap and
   * non-fatal when STT is briefly unreachable.
   *
   * Platform-wide and identical for every tenant, so — like
   * {@link checkAvailability} — it DECLARES itself tenant-less instead of
   * attaching whichever tenant happened to ask for the picker.
   */
  async getLanguageModes(): Promise<SttLanguageModeCatalog> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<SttLanguageModeCatalog>(`${this.sttBaseUrl}/internal/streaming/language-modes`, {
          timeout: 5000,
          headers: await this.sttHeaders(null, TENANTLESS.CONTROL_PLANE),
        }),
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
            // End-user language mode; STT resolves it against the
            // session engine and 422s a mode no configured engine can serve.
            language_mode: dto.languageMode ?? null,
            // Pre-start default-provider selection. STT opens the
            // session on the fallback engine when 'fallback' and a fallback is
            // configured; otherwise proceeds on primary (fail-open).
            start_on: dto.startOn ?? null,
            audio_bucket_name: dto.audioBucketName,
            // Per-tenant storage descriptor (DEDICATED tenants only; null/omitted
            // for SHARED). snake_case keys already match the Python worker schema.
            storage: dto.storage ?? null,
            // Per-tenant BYO provider credentials + fallback pointer.
            // Held by the session runtime in memory only; NEVER logged.
            provider_overrides: dto.providerOverrides ?? null,
            fallback_pipeline_id: dto.fallbackPipelineId ?? null,
            // TASK-861 — the gateway-resolved ASR spec. `null` (not absent) on the
            // deprecated pipeline path so apps/stt can tell the two apart.
            resolved_spec: dto.resolvedSpec ?? null,
            // Tenant governance for the FAILURE-DRIVEN auto switch.
            // Both are real `TenantSttConfig` settings that were resolved by the
            // gateway and then dropped here, so STT's EngineSwitchController
            // always used its own defaults — a tenant that disabled
            // auto-fallback still got it. `null` means "use the controller
            // default"; `?? null` (not a truthiness guard) so an explicit
            // `false` survives.
            auto_switch_enabled: dto.autoSwitchEnabled ?? null,
            consecutive_failure_threshold: dto.consecutiveFailureThreshold ?? null,
            // Dual-/multi-mic source count: STT stores it and
            // echoes it on the teardown summary so the usage row is repriceable.
            channel_count: dto.channelCount ?? 1,
          },
          {
            timeout: 15000,
            // The session's own tenant is REQUIRED on the DTO and is already in
            // the body as `tenant_id`; the header is the transport-level half of
            // the same fact, so the fallback below is structurally unreachable.
            headers: await this.sttHeaders(dto.tenantId, SESSION_TENANTLESS_REASON),
          },
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
        // The RESOLVED pipeline + the engine STT actually opened on.
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
   *
   * `tenantId` is threaded by callers that hold one (the compat gateway
   * resolves it from the session binding before handshake); omitted only on
   * paths whose envelope genuinely carries no tenant.
   */
  async getSessionStatus(sessionId: string, tenantId?: string | null): Promise<StreamingSessionStatus | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<StreamingSessionStatus>(`${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`, {
          timeout: 5000,
          headers: await this.sttHeaders(tenantId, SESSION_TENANTLESS_REASON),
        }),
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
   * Trigger a mid-session engine switch.
   *
   * Bidirectional for user-initiated switches: POSTs `{ target }` to the apps/stt
   * internal switch route, which XADDs a `SWITCH_TO_FALLBACK` control message
   * (carrying the target) onto the session's control stream; the in-session
   * `EngineSwitchController` performs the seamless engine swap. 404 (unknown
   * session) and 409 (target unavailable — no fallback, primary never loaded, or
   * already on that engine) are surfaced to the caller.
   */
  async switchProvider(sessionId: string, target: 'primary' | 'fallback', tenantId?: string | null): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}/switch`,
        { target },
        { timeout: 5000, headers: await this.sttHeaders(tenantId, SESSION_TENANTLESS_REASON) },
      ),
    );
    this.logger.log({ message: 'Streaming session engine switch requested', sessionId, target });
  }

  /**
   * Back-compat alias for `switchProvider(sessionId, 'fallback')`.
   */
  async switchToFallback(sessionId: string, tenantId?: string | null): Promise<void> {
    await this.switchProvider(sessionId, 'fallback', tenantId);
  }

  /**
   * Remove a streaming session (triggers finalization on STT).
   *
   * A REAL teardown now returns a usage-attribution summary
   * (see `StreamingSessionTeardownSummary`), which this emits as ONE
   * `transcribe.stream` ledger row (SESSION_SECOND + AUDIO_SECOND) through
   * `IUsageLedgerService`. The idempotent "already gone" branch (204, no
   * body) has nothing to emit — a prior successful call already did (or
   * never got the chance to, in which case there is genuinely no usage to
   * record). `interrupted` is entirely a GATEWAY-side decision (STT has no
   * concept of it): pass `true` from an abort path (resume-grace expiry,
   * shutdown) and leave it `false` (the default) for an explicit close —
   * ws-b-contract.md 's "THE ABORT RULE": both use the SAME idempotency
   * key, so a duplicate teardown is a no-op at the ledger, never a double
   * charge.
   */
  async removeSession(sessionId: string, interrupted = false, tenantId?: string | null): Promise<void> {
    let summary: StreamingSessionTeardownSummary | undefined;
    try {
      const response = await firstValueFrom(
        this.httpService.delete<StreamingSessionTeardownSummary | undefined>(`${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`, {
          timeout: 30000,
          headers: await this.sttHeaders(tenantId, SESSION_TENANTLESS_REASON),
        }),
      );
      summary = response.status === 200 ? response.data : undefined;

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

    if (summary) {
      await this.emitStreamingUsage(summary, interrupted);
    }
  }

  /**
   * Build and record the `transcribe.stream` usage rows from a teardown
   * summary. Never throws — emission is a metering side effect of work
   * already done and must never surface a failure to (or block) the caller
   * that just finished tearing the session down.
   */
  private async emitStreamingUsage(summary: StreamingSessionTeardownSummary, interrupted: boolean): Promise<void> {
    if (!this.usageLedgerService) {
      return;
    }
    // Never guess a provider — no resolved engine means no ASR model was
    // ever loaded for this session (e.g. it failed before load), so there
    // is nothing meaningful to bill against (mirrors the batch path).
    if (!summary.engine || !summary.deployment) {
      return;
    }

    try {
      await this.usageLedgerService.recordUsage({
        common: {
          tenantId: summary.tenant_id,
          sessionId: summary.session_id,
          consultationId: summary.consultation_id ?? null,
          doctorId: summary.user_id ?? null,
          idempotencyKey: UsageIdempotencyKey.sttStreamSession(summary.session_id),
          occurredAt: summary.closed_at,
          capability: AiCapability.STT,
          operation: 'transcribe.stream',
          provider: summary.engine,
          model: null,
          deployment: AiDeploymentKind[summary.deployment as keyof typeof AiDeploymentKind],
          ...(summary.deployment === 'BYOK' ? { costBasis: AiCostBasis.BYOK_NOTIONAL } : {}),
          attributesJson: {
            engine: summary.engine,
            pipelineId: summary.pipeline_id,
            languageMode: summary.language_mode ?? null,
            // Real dual-/multi-mic signal from the teardown summary;
            // defaults to 1 for a single mic or an older STT that omits it.
            channelCount: summary.channel_count ?? 1,
            streamKind: 'ws',
            interrupted,
          },
        },
        units: [
          { unit: AiUsageUnit.SESSION_SECOND, quantity: summary.session_seconds },
          { unit: AiUsageUnit.AUDIO_SECOND, quantity: summary.audio_seconds },
        ],
      });
    } catch (error) {
      this.logger.error({
        message: 'stt.stream.usage_emit_failed — session torn down but the transcribe.stream usage row was not recorded',
        sessionId: summary.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Push-back entry for the STT idle reaper.
   *
   * Normally the gateway learns a session's usage from the DELETE-teardown
   * response and calls {@link emitStreamingUsage} itself. But when the gateway
   * crashed and its removal retries were exhausted, the STT-side inactivity
   * reaper is the one that finalizes the session — it builds a teardown summary
   * that no `removeSession()` caller ever receives, and POSTs it here instead
   * (via `POST /internal/stt/streaming/usage`). Idempotent: the ledger key is
   * `sttStreamSession(sessionId)`, so a push-back that races a late DELETE
   * teardown is a no-op, never a double bill.
   */
  async recordStreamingUsageFromSummary(summary: StreamingSessionTeardownSummary, interrupted: boolean): Promise<void> {
    await this.emitStreamingUsage(summary, interrupted);
  }
}
