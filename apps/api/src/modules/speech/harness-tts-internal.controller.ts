import {
  IActiveUserContext,
  IConfigService,
  IEntitlementsService,
  IUsageLedgerService,
  SecretsService,
  TtsAgentResolverService,
  UsageIdempotencyKey,
  appendComputeAndByteUnits,
} from '@arcaai/applications';
import type { UsageEventBatchInput } from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit, generateId } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Body, Controller, HttpException, HttpStatus, Inject, Logger, Optional, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ClsService } from 'nestjs-cls';

import { Public } from '../../decorators';
import { classifyDownstreamFailure, downstreamStatusFor } from '../../filters/downstream-error';
import { HarnessServiceTokenGuard } from '../consultation/harness-service-token.guard';
import { recordUsageEmissionFailure } from '../../observability/usage-emission-metric';
import { classifyTtsProvider, isAttributableTtsProvider } from './tts-provider-classification';
import { resolveTtsRequestConfig } from './tts-tenant-config';

// Raw s16le mono PCM: 2 bytes/sample; WAV carries the same payload behind a fixed 44-byte
// header. Same constants (and same reason) as `speech-proxy.controller.ts`.
const PCM_BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

/** `apps/tts` accepts these; the node's own config schema declares the same set plus `ogg`. */
const SUPPORTED_FORMATS = ['pcm', 'wav', 'mp3'] as const;

class HarnessSynthesizeSpeechRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of. Never optional — synthesis must be attributable.' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ description: 'Text to synthesize (the workflow node`s bound `in` port).' })
  @IsString()
  @IsNotEmpty()
  // `apps/tts` owns the real ceiling (`max_input_chars`) and answers 413; this is a floor on
  // nonsense so a runaway graph cannot post a megabyte before the quota check even runs.
  @MaxLength(100_000)
  text: string;

  @ApiPropertyOptional({
    description: 'Voice identifier within the resolved agent`s bound model catalogue. Omitted ⇒ the agent`s own configured voice.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  voice?: string;

  @ApiPropertyOptional({
    description: 'An explicit TEXT_TO_SPEECH agent (lineage slug). Omitted ⇒ the tenant → department → SYSTEM AgentAssignment cascade decides.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'Audio format. Omitted ⇒ the tenant`s configured default.' })
  @IsOptional()
  @IsIn(SUPPORTED_FORMATS)
  format?: (typeof SUPPORTED_FORMATS)[number];

  @ApiPropertyOptional({ description: 'Speaking rate. Omitted ⇒ the tenant`s configured default.' })
  @IsOptional()
  @IsNumber()
  @Min(0.25)
  @Max(4)
  speed?: number;

  @ApiPropertyOptional({ description: 'BCP-47 hint.' })
  @IsOptional()
  @IsString()
  language?: string;
}

class HarnessSynthesizeSpeechResponse {
  @ApiProperty({ description: 'The whole synthesized artifact, base64-encoded.' })
  audioBase64: string;

  @ApiProperty({ description: 'MIME type of the decoded audio (audio/pcm, audio/wav, audio/mpeg).' })
  contentType: string;

  @ApiPropertyOptional({ description: 'Which provider won failover, as reported by apps/tts.' })
  provider?: string;

  @ApiProperty({ description: 'Characters apps/tts accepted — the metered unit.' })
  characters: number;
}

/**
 * HarnessTtsInternalController — the `agentic.tts` node's synthesis dispatch.
 *
 * The TTS counterpart of `internal/harness/stt/batch-jobs`, and the same division of labour: the
 * harness names WHAT to synthesize and in WHICH voice, and this gateway resolves everything the
 * tenant owns around it — routing chains, allowed providers, BYO credentials, voice bindings,
 * the character quota and the usage row — through the SAME `TenantTtsConfig` /
 * `AiProviderConnection` cascade `SpeechProxyController` already uses (`tts-tenant-config.ts`).
 *
 * ## Why this route exists rather than harness calling apps/tts directly
 *
 * `apps/tts` is the reference STATELESS, gateway-injected-config service (rule 06 §Per-tenant
 * config): it opens no DB connection and holds no credential, so every caller must arrive with
 * the tenant's resolved configuration already folded into the body. A Temporal worker has no DB
 * handle and no Vault client by design, so it cannot fold anything — a harness→tts direct call
 * could only run on `apps/tts`'s own static settings, which is a platform default silently
 * winning over a tenant's own configuration: the exact cascade bypass rule 16 exists to
 * prevent, and one that would mis-derive BYOK vs CLOUD funding while it did so.
 *
 * ## Why it lives in the speech module, not on `HarnessInternalController`
 *
 * Every dependency it needs is already imported HERE (`SpeechModule` wires the TTS config
 * resolver, the provider-connection plane, the usage ledger and the entitlements port).
 * Putting it on the consultation module's harness controller would mean threading five more
 * optional providers through a constructor that already carries fourteen, to reach services
 * that module has no other reason to know about.
 *
 * BATCH, never SSE — the same rule the STT poll route records: a Temporal activity is not a
 * long-lived connection. The browser's live view of a synthesis is served from the run's Redis
 * delta lane, which the node writes each frame to; this route is what a retriable activity can
 * actually re-issue.
 *
 * `@Public()` exempts it from the user-JWT chain and the boot-time route-permission audit; it is
 * authenticated service-to-service by `HarnessServiceTokenGuard`, exactly as every other
 * `internal/harness/*` route is. `@Public()` only sets the skip-auth label — it does not disable
 * the explicitly applied token guard.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/harness/tts')
export class HarnessTtsInternalController {
  private readonly logger = new Logger(HarnessTtsInternalController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // All three are `@Optional()` for the reason `SpeechProxyController` records: positional test
    // construction keeps its arity, and a stack without them still boots. Absent ledger /
    // entitlements ⇒ no metering and no quota check, never a blocked synthesis. An absent AGENT
    // RESOLVER is different in kind since TASK-879: `apps/tts` refuses a request with no resolved
    // spec, so a stack without it cannot synthesize at all — which is the correct fail-closed
    // outcome, not a degraded one.
    @Optional() private readonly ttsAgentResolver?: TtsAgentResolverService,
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
  ) {}

  @Post('synthesize')
  @ApiOperation({ summary: 'Synthesize speech for an agentic.tts workflow node (batch, service-to-service)' })
  async synthesize(@Body() dto: HarnessSynthesizeSpeechRequest): Promise<HarnessSynthesizeSpeechResponse> {
    const base = this.configService.getConfigValue('TTS_URL');
    if (!base) {
      throw new BadRequestException('TTS is not wired on this deployment');
    }

    // The harness calls out-of-band of the API edge CLS middleware, so tenant context is
    // re-established from the body — the same thing every `internal/harness/*` route does. The
    // tenant-scope Prisma extension reads it, so both service calls below MUST run inside it.
    return this.cls.run(async () => {
      this.cls.set('tenantId', dto.tenantId);

      const forwardBody = await this.buildForwardBody(dto);

      // PRE-FLIGHT `monthlyTtsCharacters`, before any upstream call. Unicode CODE POINTS, the
      // CHARACTER unit's own counting rule — `.length` would over-count surrogate pairs.
      const characterEstimate = [...dto.text].length;
      if (this.entitlementsService) {
        await this.entitlementsService.assertMeterQuota(dto.tenantId, 'monthlyTtsCharacters', characterEstimate);
      }

      // TASK-959 §3.2 — this route always waits for the full body (`responseType: 'arraybuffer'`),
      // so this is the batch-equivalent wall-clock fallback for the rare case `apps/tts` reports
      // no `X-Tts-Synthesis-Ms` at all.
      const startedAtMs = Date.now();
      let upstream;
      try {
        upstream = await this.httpService.axiosRef.post(`${base}/api/v1/audio/speech`, forwardBody, {
          headers: this.forwardHeaders(),
          responseType: 'arraybuffer',
          timeout: 300_000,
        });
      } catch (err) {
        throw this.upstreamException(err);
      }

      const audio = Buffer.from(upstream.data as ArrayBuffer);
      const headers = upstream.headers as Record<string, unknown>;
      const provider = (headers['x-tts-provider'] as string | undefined) || undefined;
      const characters = this.characterCount(headers, characterEstimate);

      this.emitUsage({
        tenantId: dto.tenantId,
        provider,
        characters,
        audioSeconds: this.audioSeconds(headers, audio.length),
        overrides: forwardBody.provider_overrides,
        // TASK-958 D-7 — WHICH account of that vendor `apps/tts` spent.
        connectionId: (headers['x-tts-connection-id'] as string | undefined) || null,
        headers,
        wallClockMs: Date.now() - startedAtMs,
        proxiedBytes: audio.length,
      });

      return {
        audioBase64: audio.toString('base64'),
        contentType: (headers['content-type'] as string | undefined) ?? 'application/octet-stream',
        provider,
        characters,
      };
    });
  }

  /**
   * Fold the tenant's resolved TEXT_TO_SPEECH agent onto the node's request.
   *
   * Fails CLOSED, exactly as the user-facing proxy does since TASK-879: there is no service-side
   * default left to degrade to, so an unresolvable agent surfaces as the 404/409 it is rather
   * than as an opaque 503 from a service that was handed nothing to do. A run that quietly
   * stopped honouring a tenant's agent is exactly what this must not become.
   */
  private async buildForwardBody(dto: HarnessSynthesizeSpeechRequest): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { input: dto.text, ...(dto.voice ? { voice: dto.voice } : {}) };
    if (dto.format) body.response_format = dto.format;
    if (dto.speed !== undefined) body.speed = dto.speed;

    if (!this.ttsAgentResolver) return body;
    const { spec, overrides } = await resolveTtsRequestConfig(dto.tenantId, {
      ttsAgentResolver: this.ttsAgentResolver,
      agentSlug: dto.agentSlug,
    });
    return {
      ...body,
      // The node's own config wins over the agent's parameters; the agent supplies what the node
      // left unsaid.
      ...(dto.format || spec.primary.parameters.format ? { response_format: dto.format ?? spec.primary.parameters.format } : {}),
      ...(dto.speed !== undefined || spec.primary.parameters.speed !== null ? { speed: dto.speed ?? spec.primary.parameters.speed } : {}),
      resolved_spec: spec,
      ...(Object.keys(overrides).length > 0 ? { provider_overrides: overrides } : {}),
    };
  }

  /** The ONE shared `INTERNAL_ACCESS_TOKEN` (the `TTS_SERVICE_TOKEN` fallback was retired with its descriptor, TASK-879/880). */
  private forwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/octet-stream' };
    const serviceToken = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || '';
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  /** apps/tts's own ACCEPTED count when it reported one; the pre-flight estimate otherwise. */
  private characterCount(headers: Record<string, unknown>, fallback: number): number {
    const header = headers['x-tts-characters'];
    const parsed = typeof header === 'string' ? Number(header) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  /**
   * Prefers tts's own EXACT duration (batch mode carries `X-Tts-Audio-Seconds`); falls back to
   * the same PCM/WAV byte math tts uses internally. MP3 is not derivable from a byte count.
   */
  private audioSeconds(headers: Record<string, unknown>, bytes: number): number | null {
    const exact = headers['x-tts-audio-seconds'];
    if (typeof exact === 'string' && exact.length > 0) {
      const parsed = Number(exact);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const sampleRate = Number(headers['x-tts-sample-rate']);
    const format = headers['x-tts-audio-format'];
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || bytes <= 0) return null;
    if (format === 'pcm') return bytes / (PCM_BYTES_PER_SAMPLE * sampleRate);
    if (format === 'wav') {
      const payload = bytes - WAV_HEADER_BYTES;
      return payload > 0 ? payload / (PCM_BYTES_PER_SAMPLE * sampleRate) : null;
    }
    return null;
  }

  /**
   * Stamp the CHARACTER + AUDIO_SECOND usage row. Fire-and-forget and fail-open: synthesis has
   * already happened, so a metering failure must never surface to the caller.
   *
   * `funding` is DERIVED from the override entry the cascade actually supplied
   * (`classifyTtsProvider`), never stamped by this call site — a call site that stamps it
   * mis-bills silently.
   */
  private emitUsage(args: {
    tenantId: string;
    provider?: string;
    characters: number;
    audioSeconds: number | null;
    overrides?: unknown;
    connectionId?: string | null;
    /** The raw upstream response headers — read here for the TASK-959 compute/byte dimensions. */
    headers: Record<string, unknown>;
    /** Gateway wall-clock around the whole upstream call (this route always buffers the full body). */
    wallClockMs: number;
    /** The buffered artifact's byte length — the relay-count fallback when tts reports none. */
    proxiedBytes: number;
  }): void {
    if (!this.usageLedger) return;
    const requestId = generateId();
    // TASK-957 F-10 — no provider, no row. See `isAttributableTtsProvider`.
    if (!isAttributableTtsProvider(args.provider)) {
      recordUsageEmissionFailure('tts.synthesize');
      this.logger.warn({
        message: 'TTS synthesis reported no provider; recording no usage row for it',
        requestId,
      });
      return;
    }
    const { deployment, costBasis } = args.provider
      ? // TASK-958 F9 — `connectionId` (the `X-Tts-Connection-Id` echo) selects the entry
        // out of a map that may hold two accounts of this vendor.
        classifyTtsProvider(args.provider, args.overrides as Parameters<typeof classifyTtsProvider>[1], args.connectionId)
      : { deployment: undefined, costBasis: undefined };

    const batch: UsageEventBatchInput = {
      common: {
        tenantId: args.tenantId,
        idempotencyKey: UsageIdempotencyKey.ttsRequest(requestId),
        occurredAt: new Date(),
        capability: AiCapability.TTS,
        operation: 'tts.synthesize',
        provider: args.provider ?? 'none',
        model: null,
        deployment: deployment ?? AiDeploymentKind.SELF_HOSTED,
        ...(costBasis ? { costBasis } : {}),
        connectionId: args.connectionId ?? null,
        requestId,
        // `attributesJson` stays unset here; `appendComputeAndByteUnits` below adds `device`/
        // `byteSource` ONLY when it actually appended the matching unit row. `UsageAttributes`
        // is a deliberately CLOSED allow-list that keeps PHI and free text out of the ledger.
      },
      units: [
        { unit: AiUsageUnit.CHARACTER, quantity: args.characters },
        ...(args.audioSeconds !== null ? [{ unit: AiUsageUnit.AUDIO_SECOND, quantity: args.audioSeconds }] : []),
      ],
    };

    // TASK-959 §3.2/§4.2 — what `apps/tts` reported about THIS synthesis, plus the gateway's own
    // fallbacks. The compute RULE belongs to `appendComputeAndByteUnits`, not this call site:
    // `engineMs` (the service's own `X-Tts-Synthesis-Ms`) and `totalMs` (this gateway's
    // wall-clock, ALWAYS passed) both go in, and the helper picks — preferring the engine's own
    // reading, and, for anything other than a SELF_HOSTED call, billing the platform's calling
    // CPU regardless of `device`. Only a SELF_HOSTED call with no resolved device gets no
    // compute row.
    const device = args.headers['x-tts-device'] as string | undefined;
    const synthesisMs = Number(args.headers['x-tts-synthesis-ms']);
    const reportedBytes = Number(args.headers['x-tts-response-bytes']);
    const hasReportedBytes = Number.isFinite(reportedBytes) && reportedBytes > 0;
    // The service's own count first; the buffered artifact length — an application-level proxy,
    // not the wire — only when it reported none.
    const responseBytes = hasReportedBytes ? reportedBytes : args.proxiedBytes;
    const byteSource = hasReportedBytes ? (args.headers['x-tts-byte-source'] as string | undefined) : args.proxiedBytes > 0 ? 'app' : undefined;

    const { batch: augmented, platformBatch } = appendComputeAndByteUnits(batch, {
      device,
      engineMs: synthesisMs,
      totalMs: args.wallClockMs,
      // No vendor "request" bytes concept here: the node's text is a JSON field, never counted
      // as bytes spent AT a vendor the way an outbound STT/TEXT call is.
      requestBytes: undefined,
      responseBytes,
      byteSource,
    });

    const onUsageError = (err: unknown): void => {
      this.logger.warn({
        message: 'TTS usage emission failed for a harness synthesis',
        error: err instanceof Error ? err.message : String(err),
      });
    };
    this.usageLedger.recordUsage(augmented).catch(onUsageError);
    if (platformBatch) {
      // TASK-959 §6.3 — the platform's own CPU on a BYOK call: same batch shape, disjoint
      // idempotency key (`:CPU_SECOND`), separate row so it never drops off `augmented`'s key.
      this.usageLedger.recordUsage(platformBatch).catch(onUsageError);
    }
  }

  /** Never forward or log the upstream body — a synthesis error can echo the input text (PHI). */
  private upstreamException(err: unknown): HttpException {
    const status = (err as AxiosError)?.response?.status;
    this.logger.error({ message: 'TTS upstream error for a harness synthesis (body redacted — may contain PHI)', upstreamStatus: status });
    if (typeof status === 'number') {
      return new HttpException({ detail: 'TTS synthesize failed' }, status);
    }
    const kind = classifyDownstreamFailure(err);
    return new HttpException({ detail: 'TTS synthesize failed' }, kind ? downstreamStatusFor(kind) : HttpStatus.BAD_GATEWAY);
  }
}
