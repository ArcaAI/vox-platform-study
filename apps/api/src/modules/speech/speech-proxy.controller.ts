import {
  Authorize,
  IActiveUserContext,
  IConfigService,
  IEntitlementsService,
  IProviderConnectionService,
  ITenantTtsConfigService,
  IUsageLedgerService,
  SecretsService,
  UsageIdempotencyKey,
} from '@arcaai/applications';
import type { ProviderOverrides } from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit, generateId } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import { ClsService } from 'nestjs-cls';
import { Body, Controller, Get, HttpException, HttpStatus, Inject, Logger, Optional, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import type { Response } from 'express';
import { type ProviderFunding, classifyTtsProvider } from './tts-provider-classification';
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
  voice: string;
  response_format?: 'pcm' | 'wav' | 'mp3';
  speed?: number;
  stream_format?: 'audio' | 'sse';
  model?: string;
  // Injected by the gateway from the tenant's resolved config.
  routing_en?: string[];
  routing_ml?: string[];
  allowed_providers?: string[];
  // `funding` labels WHO PAID for the credential: the caller
  // tenant's own connection row, or the SYSTEM-tenant platform default. tts
  // ignores it (it reads named credential keys only); the gateway reads it back
  // when it stamps the usage row. Absent ⇒ `'tenant'`.
  provider_overrides?: Record<string, { api_key: string; region?: string; base_url?: string; funding?: ProviderFunding }>;
  // Resolved voice bindings ({internalVoiceId: {provider: providerVoiceName}});
  // tts falls back to its built-in DEFAULT_VOICES when absent.
  voice_bindings?: Record<string, Record<string, string>>;
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
// TASK-742: the TTS proxy — the other surface the conformance review named
// as reachable unauthorized. Gated by the new `tts:*` family rather than an
// `stt:*` scope, so a transcription key cannot synthesise speech.
@RequiredScopes('tts:speech:write')
export class SpeechProxyController {
  private readonly logger = new Logger(SpeechProxyController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolve the caller tenant's TTS spec + inject it downstream.
    // Optional so positional test construction (and internal service-token calls
    // without a tenant context) still work; injection is a no-op when absent.
    @Optional() @Inject(ITenantTtsConfigService) private readonly tenantTtsConfig?: ITenantTtsConfigService,
    // BYO provider credential injection (`service='tts'`) — the
    // unified provider-connection plane. Optional for the same reason as above.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnectionService?: IProviderConnectionService,
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
   * Resolve the caller tenant's effective TTS spec and fold it into
   * the forwarded body: fill omitted format/speed from the tenant defaults, and
   * always pass the resolved provider chains + whitelist. Fails OPEN — a config
   * lookup error never blocks synthesis; tts falls back to its own settings.
   */
  private async applyTenantConfig(body: SpeechSynthesizeRequest): Promise<SpeechSynthesizeRequest> {
    const tenantId = this.cls?.get('tenantId');
    if (!this.tenantTtsConfig || !tenantId) return body;
    try {
      const [eff, resolved] = await Promise.all([
        this.tenantTtsConfig.getEffective(tenantId),
        this.providerConnectionService
          ? this.providerConnectionService.resolveTenantCloudOverrides('tts', tenantId)
          : Promise.resolve({ overrides: {} as ProviderOverrides }),
      ]);
      // The map now spans two tiers (the tenant's own rows over the
      // SYSTEM-tenant platform default) and each entry carries its `funding`,
      // which `classifyTtsProvider` reads back to stamp the usage row.
      const overrides = resolved.overrides;
      return {
        ...body,
        response_format: body.response_format ?? (eff.defaultFormat as 'pcm' | 'wav' | 'mp3'),
        speed: body.speed ?? eff.defaultSpeed,
        routing_en: eff.routingEn,
        routing_ml: eff.routingMl,
        allowed_providers: eff.allowedProviders,
        ...(Object.keys(overrides).length > 0 ? { provider_overrides: overrides } : {}),
        // Resolved voice bindings (tenant over SYSTEM merge); only
        // injected when non-empty so tts keeps its built-in defaults otherwise.
        ...(eff.voiceBindings && Object.keys(eff.voiceBindings).length > 0 ? { voice_bindings: eff.voiceBindings } : {}),
      };
    } catch (err) {
      this.logger.warn({
        message: 'Tenant TTS config resolve failed; forwarding with service defaults',
        error: err instanceof Error ? err.message : String(err),
      });
      return body;
    }
  }

  // TTS base URL resolves through the typed IConfigService accessor; direct
  // process.env.TTS_URL reads in modules/** are lint-banned.
  private getTtsBaseUrl(): string {
    return this.configService.getConfigValue('TTS_URL');
  }

  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const serviceToken = this.secretsService?.getSecretSync('TTS_SERVICE_TOKEN');
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
    return new HttpException({ detail: fallbackMessage }, HttpStatus.BAD_GATEWAY);
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
    const forwardBody = await this.applyTenantConfig(body);

    // PRE-FLIGHT monthlyTtsCharacters check, before any
    // upstream call. `applyTenantConfig` never touches `input`, so this counts
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
