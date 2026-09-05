import {
  Authorize,
  IActiveUserContext,
  IConfigService,
  IEntitlementsService,
  IUsageLedgerService,
  SecretsService,
  TtsAgentResolverService,
  UsageIdempotencyKey,
} from '@arcaai/applications';
import type { ResolvedTtsSpec } from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit, generateId } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import { ClsService } from 'nestjs-cls';
import { Body, Controller, Get, HttpException, HttpStatus, Inject, Logger, Optional, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';

import { classifyDownstreamFailure, downstreamStatusFor } from '../../filters/downstream-error';
import type { Response } from 'express';
import { type ProviderFunding, classifyTtsProvider } from './tts-provider-classification';
import { resolveTtsRequestConfig } from './tts-tenant-config';
import { RequiredScopes } from '../../decorators';

// Raw s16le mono PCM: 2 bytes/sample. WAV carries the same payload behind a
// fixed 44-byte header. Mirrors tts.core.usage.compute_audio_seconds — kept
// in lockstep so the gateway-derived streaming figure agrees with tts's own.
const PCM_BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

// The gateway forwards the body verbatim; tts owns strict validation. A plain
// interface (not a class-validator DTO) means the global ValidationPipe skips it,
// preserving pass-through (mirrors TextProxyController).
interface SpeechSynthesizeRequest {
  input: string;
  /**
   * OPTIONAL since TASK-879. Absent ⇒ the resolved agent's own `parameters.voice`, which is what
   * a caller that has not chosen a voice should get: the tenant's configured voice, not a service
   * default. When present it must be one the resolved model declares — `apps/tts` answers 404
   * rather than substituting a voice nobody asked for.
   */
  voice?: string;
  response_format?: 'pcm' | 'wav' | 'mp3';
  speed?: number;
  stream_format?: 'audio' | 'sse';
  model?: string;
  /**
   * The caller's explicit TEXT_TO_SPEECH agent (a lineage slug). Absent ⇒ the tenant → department
   * → SYSTEM `AgentAssignment` cascade decides. Stripped before forwarding: it is a SELECTOR for
   * this gateway, and what `apps/tts` receives is the RESOLUTION.
   */
  agentSlug?: string;
  // ── Injected by the gateway; never accepted from a caller ────────────────────────────────
  /**
   * The resolved TEXT_TO_SPEECH agent: engine chain, model (with mirror, artifacts and voices),
   * connections and the funding-gated fallback governance. It REPLACED `routing_en` /
   * `routing_ml` / `allowed_providers` / `voice_bindings`, which were the `TenantTtsConfig` fold.
   */
  resolved_spec?: ResolvedTtsSpec;
  // `funding` labels WHO PAID for the credential: the caller
  // tenant's own connection row, or the SYSTEM-tenant platform default. tts
  // ignores it (it reads named credential keys only); the gateway reads it back
  // when it stamps the usage row. Absent ⇒ `'tenant'`.
  provider_overrides?: Record<string, { api_key: string; region?: string; base_url?: string; funding?: ProviderFunding }>;
}

interface UpstreamErrorPayload {
  detail?: string;
  message?: string;
  [key: string]: unknown;
}

const RETRIABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
// Only connect-phase failures prove the request never reached tts. Synthesis
// is compute-costly (and streams), so the non-idempotent POST retries ONLY on
// these — anything else may mean synthesis already started.
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

@ApiTags('speech')
@ApiBearerAuth()
@Controller('speech')
// the TTS proxy — the other surface the conformance review named
// as reachable unauthorized. Gated by the new `tts:*` family rather than an
// `stt:*` scope, so a transcription key cannot synthesise speech.
@RequiredScopes('tts:speech:write')
export class SpeechProxyController {
  private readonly logger = new Logger(SpeechProxyController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolve the caller tenant's TEXT_TO_SPEECH agent and inject the resolved spec + its
    // credentials downstream. Optional so positional test construction (and internal
    // service-token calls without a tenant context) still work; injection is a no-op when absent.
    @Optional() private readonly ttsAgentResolver?: TtsAgentResolverService,
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // Emits CHARACTER + AUDIO_SECOND usage rows at stream
    // teardown. Optional/trailing so existing positional test fixtures keep
    // compiling; absent (or no resolvable tenantId) ⇒ no emission, fail-open —
    // metering must never block synthesis.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // PRE-FLIGHT monthlyTtsCharacters allowance check, BEFORE
    // the upstream TTS call — characters are knowable upfront here (the whole
    // `input` string is in the request body), unlike the WS-duplex gateway.
    // Optional/trailing so existing positional test fixtures keep compiling;
    // absent (or no resolvable tenantId) ⇒ no check, fail-open (kill-switch-
    // gated inside the service — a no-op until an operator opts in per-env).
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
  ) {}

  /**
   * Resolve the caller tenant's TEXT_TO_SPEECH agent and fold it into the forwarded body.
   *
   * The RESOLVE is shared with the WS-duplex gateway and the harness's internal synthesis route
   * (`tts-tenant-config.ts`); the MAPPING stays here, because this route honours a
   * caller-supplied format/speed and the other two take their own caller's.
   *
   * FAILS CLOSED, unlike the `TenantTtsConfig` fold it replaces. There is no service-side default
   * left to degrade to — `apps/tts` reads no selection of its own and refuses a request with no
   * spec — so an unresolvable agent must surface as the 404/409 it is (an unknown or foreign
   * `agentSlug`, an agent that binds no runnable model, a vetoed provider) rather than as an
   * opaque 503 from a service that was handed nothing to do.
   */
  private async applyAgentSpec(body: SpeechSynthesizeRequest): Promise<SpeechSynthesizeRequest> {
    const tenantId = this.cls?.get('tenantId');
    const { agentSlug, ...forwarded } = body;
    if (!this.ttsAgentResolver || !tenantId) return forwarded;
    const { spec, overrides } = await resolveTtsRequestConfig(tenantId, {
      ttsAgentResolver: this.ttsAgentResolver,
      agentSlug,
    });
    return {
      ...forwarded,
      // The agent's own parameters are the defaults; a caller that named one keeps it.
      response_format: forwarded.response_format ?? ((spec.primary.parameters.format ?? undefined) as 'pcm' | 'wav' | 'mp3' | undefined),
      speed: forwarded.speed ?? spec.primary.parameters.speed ?? undefined,
      resolved_spec: spec,
      ...(Object.keys(overrides).length > 0 ? { provider_overrides: overrides } : {}),
    };
  }

  // TTS base URL resolves through the typed IConfigService accessor; direct
  // process.env.TTS_URL reads in modules/** are lint-banned.
  private getTtsBaseUrl(): string {
    return this.configService.getConfigValue('TTS_URL');
  }

  /**
   * TASK-879 — the ONE shared `INTERNAL_ACCESS_TOKEN`; `TTS_SERVICE_TOKEN` is consulted only as
   * the migration fallback, matching what `text-proxy` / `text-compat` already do. Both lookups
   * are the SYNC cache read warmed at bootstrap, so the existing fail-open-on-miss behaviour is
   * unchanged: a deployment that configured only the legacy token keeps working.
   */
  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const serviceToken = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || this.secretsService?.getSecretSync('TTS_SERVICE_TOKEN');
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  private isRetriable(err: unknown): boolean {
    const code = (err as AxiosError)?.code;
    if (code && RETRIABLE_CODES.has(code)) return true;
    const status = (err as AxiosError)?.response?.status;
    return status === 502 || status === 503 || status === 504;
  }

  private isConnectPhaseFailure(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response) return false; // upstream responded → request delivered
    const code = axiosError?.code;
    return typeof code === 'string' && CONNECT_PHASE_CODES.has(code);
  }

  private buildUpstreamException(err: unknown, fallbackMessage: string): HttpException {
    const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
    const status = axiosError.response?.status;
    const payload = axiosError.response?.data;
    // Never forward or log the upstream body — a synthesis error can echo the
    // input text (PHI). Record only non-content metadata + the status.
    if (payload !== undefined && payload !== null && payload !== '') {
      this.logger.error({
        message: 'TTS upstream error (body redacted — may contain PHI)',
        upstreamStatus: status,
        upstreamBodyRedacted: true,
      });
    }
    if (typeof status === 'number') {
      return new HttpException({ detail: fallbackMessage }, status);
    }
    // see `text-proxy.controller.ts`: no upstream status ⇒ transport
    // failure ⇒ 503, from the shared classifier. Body shape unchanged.
    const kind = classifyDownstreamFailure(err);
    return new HttpException({ detail: fallbackMessage }, kind ? downstreamStatusFor(kind) : HttpStatus.BAD_GATEWAY);
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxRetries = 2,
    isRetriable: (err: unknown) => boolean = (err) => this.isRetriable(err),
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && isRetriable(err)) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn({ message: `Retrying ${context}`, attempt: attempt + 1, maxRetries, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }

  /**
   * Accepted characters are tts's own count (X-Tts-Characters,
   * computed AFTER its 413 guard — the single source of truth for what was
   * actually accepted). A missing/malformed header falls back to counting
   * code points on the exact forwarded input — defensive only, never the
   * primary path.
   */
  private resolveCharacterCount(headers: Record<string, unknown>, input: string): number {
    const header = headers['x-tts-characters'];
    const parsed = typeof header === 'string' ? Number(header) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : [...input].length;
  }

  /**
   * Prefers tts's own EXACT duration (batch mode: X-Tts-Audio-Seconds).
   * Streaming modes never carry it (unknowable before headers commit) — the
   * gateway derives it from the byte count it observed while proxying, using
   * the same PCM/WAV byte math tts uses internally. MP3 is never derivable
   * from a byte count and returns `null` on both paths.
   */
  private resolveAudioSeconds(headers: Record<string, unknown>, proxiedBytes: number): number | null {
    const exact = headers['x-tts-audio-seconds'];
    if (typeof exact === 'string' && exact.length > 0) {
      const parsed = Number(exact);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const sampleRate = Number(headers['x-tts-sample-rate']);
    const format = headers['x-tts-audio-format'];
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || proxiedBytes <= 0) return null;
    if (format === 'pcm') return proxiedBytes / (PCM_BYTES_PER_SAMPLE * sampleRate);
    if (format === 'wav') {
      const payload = proxiedBytes - WAV_HEADER_BYTES;
      return payload > 0 ? payload / (PCM_BYTES_PER_SAMPLE * sampleRate) : null;
    }
    return null; // mp3 / unknown — compressed, not derivable from byte count
  }

  @Post('synthesize')
  @Authorize()
  @ApiOperation({ summary: 'Synthesize speech via TTS (batch audio, streamed audio, or SSE)' })
  async synthesize(@Body() body: SpeechSynthesizeRequest, @Res() res: Response): Promise<void> {
    const base = this.getTtsBaseUrl();
    const forwardBody = await this.applyAgentSpec(body);

    // PRE-FLIGHT monthlyTtsCharacters check, before any
    // upstream call. `applyAgentSpec` never touches `input`, so this counts
    // the same text that will actually be synthesized. Unicode CODE POINTS
    // (`[...input].length`), matching the CHARACTER unit's counting rule
    // (no CJK/Indic double-counting) — `.length` would over-count surrogate
    // pairs. Throws `QuotaExceededException` (→ 429) when this request would
    // push the tenant over its monthly allowance; a no-op when the kill-switch
    // is off, the allowance is null (unlimited), or there is no tenant context.
    const tenantId = this.cls?.get('tenantId');
    if (tenantId && this.entitlementsService) {
      await this.entitlementsService.assertMeterQuota(tenantId, 'monthlyTtsCharacters', [...forwardBody.input].length);
    }

    try {
      const upstream = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/audio/speech`, forwardBody, {
            headers: { ...this.getForwardHeaders(), Accept: 'application/octet-stream, text/event-stream' },
            responseType: 'stream',
            timeout: 300_000,
          }),
        'TTS synthesize',
        // Non-idempotent: retry only when the request provably never left the gateway.
        2,
        (err) => this.isConnectPhaseFailure(err),
      );

      // Mirror the upstream content type (audio/pcm, audio/wav, audio/mpeg, or
      // text/event-stream) and stream bytes through untouched — no compression
      // (no-transform), no buffering (X-Accel-Buffering), no caching (PHI).
      const contentType = (upstream.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Accumulated across the whole proxy lifetime and
      // recorded exactly once at teardown — success or abort (client
      // disconnect / upstream stream error). requestId is minted fresh per
      // HTTP call since this proxy has no client-supplied one; one physical
      // call always tears down through exactly one of end/error/close.
      const tenantId = this.cls?.get('tenantId');
      const characters = this.resolveCharacterCount(upstream.headers, forwardBody.input);
      const provider = (upstream.headers['x-tts-provider'] as string | undefined) || undefined;
      const { deployment, costBasis } = provider
        ? classifyTtsProvider(provider, forwardBody.provider_overrides)
        : { deployment: undefined, costBasis: undefined };
      const requestId = generateId();
      let proxiedBytes = 0;
      let emitted = false;

      const emitUsage = (interrupted: boolean): void => {
        if (emitted || !tenantId || !this.usageLedger) return;
        emitted = true;
        const audioSeconds = this.resolveAudioSeconds(upstream.headers, proxiedBytes);
        this.usageLedger
          .recordUsage({
            common: {
              tenantId,
              idempotencyKey: UsageIdempotencyKey.ttsRequest(requestId),
              occurredAt: new Date(),
              capability: AiCapability.TTS,
              operation: 'tts.synthesize',
              provider: provider ?? 'none',
              model: null,
              deployment: deployment ?? AiDeploymentKind.SELF_HOSTED,
              ...(costBasis ? { costBasis } : {}),
              requestId,
              attributesJson: { interrupted },
            },
            units: [
              { unit: AiUsageUnit.CHARACTER, quantity: characters },
              ...(audioSeconds !== null ? [{ unit: AiUsageUnit.AUDIO_SECOND, quantity: audioSeconds }] : []),
            ],
          })
          .catch((err: unknown) => {
            // Never let a metering failure surface to the caller — synthesis
            // already happened; this is a side effect of work already done.
            this.logger.warn({
              message: 'TTS usage emission failed',
              error: err instanceof Error ? err.message : String(err),
            });
          });
      };

      const stream = upstream.data;
      stream.on('data', (chunk: Buffer) => {
        proxiedBytes += chunk.length;
        res.write(chunk);
      });
      stream.on('end', () => {
        res.end();
        emitUsage(false);
      });
      stream.on('error', (err: Error) => {
        this.logger.error({ message: 'TTS audio stream error', error: err.message });
        res.end();
        emitUsage(true);
      });
      res.on('close', () => {
        stream.destroy();
        emitUsage(true);
      });
    } catch (err) {
      const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
      const upstreamStatus = axiosError.response?.status;
      const payload = axiosError.response?.data;
      if (payload !== undefined && payload !== null && payload !== '') {
        this.logger.error({
          message: 'TTS synthesize upstream error (body redacted — may contain PHI)',
          upstreamStatus,
          upstreamBodyRedacted: true,
        });
      } else {
        this.logger.error({
          message: 'Failed to proxy synthesize to TTS',
          error: err instanceof Error ? err.message : String(err),
          code: axiosError.code,
          upstreamStatus,
        });
      }
      // flushHeaders only runs after a successful upstream connect, so on this
      // path headers are not yet sent — respond with a generic status.
      if (!res.headersSent) {
        const status = typeof upstreamStatus === 'number' ? upstreamStatus : HttpStatus.BAD_GATEWAY;
        res.status(status).json({ detail: 'TTS service unavailable' });
      } else {
        res.end();
      }
    }
  }

  @Get('voices')
  @Authorize()
  @ApiOperation({ summary: 'List available TTS voices (stable internal ids + providers)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async voices(): Promise<any> {
    const base = this.getTtsBaseUrl();
    try {
      const response = await this.withRetry(
        () => this.httpService.axiosRef.get(`${base}/api/v1/voices`, { headers: this.getForwardHeaders(), timeout: 5_000 }),
        'TTS voices',
      );
      return response.data;
    } catch (err) {
      this.logger.error({
        message: 'Failed to list TTS voices',
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus: (err as AxiosError)?.response?.status,
      });
      throw this.buildUpstreamException(err, 'TTS service unavailable');
    }
  }
}
