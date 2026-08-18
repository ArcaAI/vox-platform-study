import { Authorize, IApiKeyService, ITenantSttConfigService, PipelineService, StreamingSessionService } from '@arcaai/applications';
import type { SttProviderOverrides } from '@arcaai/applications';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Post,
  Req,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { StreamSessionTenantBindingService } from '../../common';
import { StartSessionRequest } from './dto/start-session.request';
import { SwitchSessionRequest } from './dto/switch-session.request';
import { SttCompatSessionMetadataService } from './stt-compat-session-metadata.service';
import type { AudioConfig, StartSessionResponse } from './dto/start-session.response';
import type { SwitchSessionResponse } from './dto/switch-session.response';
import { StopSessionRequest } from './dto/stop-session.request';
import type { StopSessionResponse } from './dto/stop-session.response';
import { RequiredScopes } from '../../decorators';

/** The caller identity resolved from the request / API key / CLS. */
type ResolvedCaller = {
  tenantId?: string;
  userId?: string;
  user?: { id?: string; tenantId?: string };
  authenticatedKey?: { tenantId?: string; userId?: string };
};

type CompatRequest = {
  apiKey?: { tenantId?: string; userId?: string };
  user?: { id?: string; tenantId?: string };
  headers?: Record<string, string | string[] | undefined>;
};

const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  sampleRate: 16000,
  format: 'pcm',
  channels: 1,
  bitDepth: 16,
  chunkSize: 1024,
  noiseCancellation: true,
  echoCancellation: true,
  autoGainControl: true,
  compressed_stream_format: null,
  wave_stream_format: 1,
};

@ApiTags('stt-compat')
@ApiBearerAuth()
@Controller('api/stt')
// TASK-742: v1-compat STT session surface (start/switch/stop) — streaming
// control, so the stream scope rather than the transcription-record one.
@RequiredScopes('stt:stream:write')
export class SttCompatController {
  private readonly logger = new Logger(SttCompatController.name);

  constructor(
    @Optional() private readonly pipelineService?: PipelineService,
    @Optional() private readonly sessionService?: StreamingSessionService,
    @Optional() private readonly sessionBinding?: StreamSessionTenantBindingService,
    @Optional() private readonly cls?: ClsService,
    @Optional() @Inject(IApiKeyService) private readonly apiKeyService?: IApiKeyService,
    @Optional() private readonly sessionMetadataService?: SttCompatSessionMetadataService,
    // Resolves the caller tenant's STT fallback spec + BYO provider overrides
    // . Optional so positional test construction still works and a
    // stack without the module degrades gracefully; injection is fail-open.
    @Optional() @Inject(ITenantSttConfigService) private readonly sttConfig?: ITenantSttConfigService,
  ) {}

  @Post('start_session')
  @Authorize()
  @ApiOperation({ summary: 'v1-compatible STT session start' })
  async startSession(@Body() body: StartSessionRequest, @Req() request: CompatRequest = {}): Promise<StartSessionResponse> {
    const provider = body.provider === 'whisper' ? 'azure' : (body.provider ?? 'azure');
    const response: StartSessionResponse = {
      message: 'Session started',
      session_id: body.session_id,
      status: 'active',
      audio_config: this.mergeAudioConfig(body.audioSettings),
      provider,
    };

    if (!this.pipelineService || !this.sessionService || !this.sessionBinding) {
      return response;
    }

    const { tenantId, userId, user, authenticatedKey } = await this.resolveCaller(request);
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelineService = this.pipelineService;
    const sessionService = this.sessionService;
    const sessionBinding = this.sessionBinding;
    const createSession = async (): Promise<StartSessionResponse> => {
      // C4: an explicit `pipelineId` is used directly (bypassing the
      // provider-enum selection); otherwise the pipeline is picked from `provider`.
      let pipelineId = body.pipelineId;
      if (!pipelineId) {
        const pipelines = await pipelineService.getAll();
        const pipeline = this.selectPipeline(pipelines, provider);
        if (!pipeline) {
          throw new BadRequestException('No STT pipeline is configured for this tenant');
        }
        pipelineId = pipeline.id;
      }

      // Always resolve the tenant fallback + BYO overrides (fail-open — a broken
      // or absent config must never block session creation).
      const { providerOverrides, fallbackPipelineId, autoSwitchEnabled, consecutiveFailureThreshold } = await this.resolveSttFallbackConfig(tenantId);

      // Pre-start default-provider selection. Map the compat
      // vocabulary (pipeline≡primary, default≡fallback) to the applications
      // `startOn`. Fail-closed: opening on the default engine requires a
      // resolved fallback pipeline (mirrors the C3 switch guard).
      const startOn = body.startOn === 'default' ? 'fallback' : body.startOn === 'pipeline' ? 'primary' : undefined;
      if (startOn === 'fallback' && !fallbackPipelineId) {
        throw new ConflictException('No fallback pipeline configured for this tenant');
      }

      const session = await sessionService.createSession({
        sessionId: body.session_id,
        tenantId,
        pipelineId,
        sampleRate: body.audioSettings.sampleRate,
        userId,
        language: body.language ?? undefined,
        providerOverrides,
        fallbackPipelineId,
        // Tenant auto-switch governance. `!== undefined`, not
        // truthiness — `false` is the choice worth carrying.
        ...(autoSwitchEnabled !== undefined ? { autoSwitchEnabled } : {}),
        ...(consecutiveFailureThreshold !== undefined ? { consecutiveFailureThreshold } : {}),
        ...(startOn ? { startOn } : {}),
      });
      if (!session) {
        throw new BadRequestException('STT streaming service is at capacity');
      }

      await Promise.all([
        sessionBinding.bind(body.session_id, tenantId),
        sessionBinding.bindSessionMeta(body.session_id, { sampleRate: body.audioSettings.sampleRate }),
        this.sessionMetadataService?.setLanguage(body.session_id, body.language),
      ]);

      // Echo the RESOLVED baseline — additive, so v1 clients that
      // ignore unknown keys are unaffected. Spread only when STT reported it.
      return {
        ...response,
        ...(session.pipelineId ? { pipeline_id: session.pipelineId } : {}),
        ...(session.activeEngine ? { active_engine: session.activeEngine } : {}),
      };
    };

    if (this.cls) {
      return this.cls.run(async () => {
        this.cls?.set('tenantId', tenantId);
        if (user ?? authenticatedKey?.userId) {
          this.cls?.set('user', user ?? { id: authenticatedKey?.userId, tenantId });
        }
        return createSession();
      });
    }

    return createSession();
  }

  /**
   * v1-compatible mid-session engine switch.
   *
   * x-api-key auth; the tenant is resolved exactly as `startSession` does. The
   * session is tenant-owned: BOTH native and compat sessions are tracked in the
   * same `StreamSessionTenantBindingService` (sessionId → tenantId), so a single
   * binding lookup enforces ownership for either creation path. A foreign or
   * unknown session 404s (no existence leak). Fail-CLOSED on selection: a
   * `default`/`fallback` switch with no fallback configured → 409 (never a silent
   * no-op). A downstream 409 (already on target / unavailable) → 409, 404 → 404.
   */
  @Post('switch')
  @HttpCode(200)
  @Authorize()
  @ApiOperation({ summary: 'v1-compatible STT mid-session engine switch' })
  @ApiResponse({ status: 200, description: 'Switch requested; the session continues on the target engine.' })
  @ApiResponse({ status: 404, description: 'Unknown or foreign session (no existence leak).' })
  @ApiResponse({ status: 409, description: 'No fallback configured, or the session is already on the target engine.' })
  async switchSession(@Body() body: SwitchSessionRequest, @Req() request: CompatRequest = {}): Promise<SwitchSessionResponse> {
    if (!this.sessionService) {
      throw new ServiceUnavailableException('STT streaming service is not available');
    }

    const { tenantId } = await this.resolveCaller(request);
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Tenant ownership (404-over-403). Absent binding service ⇒ cannot prove
    // ownership ⇒ 404 (fail-closed).
    const boundTenant = this.sessionBinding ? await this.sessionBinding.lookup(body.session_id) : null;
    if (!boundTenant || boundTenant !== tenantId) {
      throw new NotFoundException('Resource not found');
    }

    const target = this.normalizeSwitchTarget(body.target);

    // Fail-closed selection guard: a fallback switch needs a configured fallback.
    if (target === 'fallback' && this.sttConfig) {
      const effective = await this.sttConfig.getEffective(tenantId);
      if (!effective.fallbackPipelineId) {
        throw new ConflictException('No fallback pipeline configured for this tenant');
      }
    }

    try {
      await this.sessionService.switchProvider(body.session_id, target, tenantId);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        throw new ConflictException('Session is already on the requested engine, or the target is unavailable');
      }
      if (status === 404) {
        throw new NotFoundException(`Streaming session ${body.session_id} not found`);
      }
      throw err;
    }

    return { switched: true, active: target === 'primary' ? 'pipeline' : 'default' };
  }

  /** Normalize the compat switch vocabulary to the bidirectional engine target. */
  private normalizeSwitchTarget(target: SwitchSessionRequest['target']): 'primary' | 'fallback' {
    return target === 'pipeline' || target === 'primary' ? 'primary' : 'fallback';
  }

  /**
   * Resolve the caller's tenant + user from the request, API key, or CLS —
   * shared by `startSession` and `switchSession` so both authenticate identically.
   */
  private async resolveCaller(request: CompatRequest): Promise<ResolvedCaller> {
    const user = request.user ?? this.cls?.get<{ id?: string; tenantId?: string }>('user');
    const rawApiKeyHeader = request.headers?.['x-api-key'];
    const rawApiKey = Array.isArray(rawApiKeyHeader) ? rawApiKeyHeader[0] : rawApiKeyHeader;
    const authenticatedKey = rawApiKey && this.apiKeyService ? await this.apiKeyService.authenticateByRawKey(rawApiKey, undefined) : undefined;
    const tenantId = user?.tenantId ?? request.apiKey?.tenantId ?? authenticatedKey?.tenantId ?? this.cls?.get<string>('tenantId');
    const userId = user?.id ?? request.apiKey?.userId ?? authenticatedKey?.userId;
    return { tenantId, userId, user, authenticatedKey };
  }

  /**
   * Resolve the tenant's effective fallback pipeline + decrypted BYO provider
   * overrides for a new compat streaming session. FAIL-OPEN: any
   * resolve/decrypt error (or an unwired config service) yields no overrides and
   * no fallback so the session is still created on platform env creds — a broken
   * BYO key must never block transcription. Decrypted overrides are handed
   * straight to the session payload and NEVER logged here.
   */
  private async resolveSttFallbackConfig(tenantId: string): Promise<{
    providerOverrides?: SttProviderOverrides;
    fallbackPipelineId?: string;
    autoSwitchEnabled?: boolean;
    consecutiveFailureThreshold?: number;
  }> {
    if (!this.sttConfig) {
      return {};
    }
    try {
      const [effective, overrides] = await Promise.all([this.sttConfig.getEffective(tenantId), this.sttConfig.resolveProviderOverrides(tenantId)]);
      return {
        providerOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        fallbackPipelineId: effective.fallbackPipelineId ?? undefined,
        // The governance half of the same resolved config.
        autoSwitchEnabled: effective.autoSwitchEnabled ?? undefined,
        consecutiveFailureThreshold: effective.consecutiveFailureThreshold ?? undefined,
      };
    } catch (err) {
      this.logger.warn({
        message: 'Tenant STT config resolve failed; creating compat session without fallback/overrides',
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  @Post('stop_session')
  @HttpCode(200)
  @Authorize()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'v1-compatible STT session stop' })
  @UseInterceptors(FileInterceptor('audio_file'))
  async stopSession(@UploadedFile() audioFile: Express.Multer.File | undefined, @Body() body: StopSessionRequest): Promise<StopSessionResponse> {
    if (this.sessionService && this.sessionBinding) {
      // TASK-737: this compat route is API-key authenticated, so CLS is not a
      // reliable tenant source here (the text-compat trap). The session's own
      // binding — written by `start_session` and cleared one line below — is.
      const boundTenant = await this.sessionBinding.lookup(body.session_id).catch(() => null);
      await this.sessionService.removeSession(body.session_id, false, boundTenant);
      await this.sessionBinding.clear(body.session_id);
    }
    await this.sessionMetadataService?.clear(body.session_id);

    const audioUploaded = Boolean(audioFile?.size);
    return {
      message: audioUploaded ? 'Session stopped and audio saved' : 'Session stopped',
      session_id: body.session_id,
      status: 'stopped',
      audio_uploaded: audioUploaded,
      ...(audioUploaded
        ? {
            audio_config: {
              sample_rate: body.sample_rate ?? DEFAULT_AUDIO_CONFIG.sampleRate,
              channels: body.channels ?? DEFAULT_AUDIO_CONFIG.channels,
              bit_depth: body.bit_depth ?? DEFAULT_AUDIO_CONFIG.bitDepth,
              size_bytes: audioFile?.size ?? 0,
            },
          }
        : {}),
    };
  }

  private selectPipeline(
    pipelines: Awaited<ReturnType<PipelineService['getAll']>>,
    provider: StartSessionRequest['provider'],
  ): (typeof pipelines)[number] | undefined {
    const providerKey = provider ?? 'azure';
    const providerPipeline = pipelines.find(
      (pipeline) =>
        pipeline.tags.some((tag) => tag.toLowerCase() === providerKey) ||
        pipeline.slug.toLowerCase().includes(providerKey) ||
        pipeline.name.toLowerCase().includes(`[${providerKey}]`),
    );

    if (providerKey === 'whisper') {
      return pipelines.find((pipeline) => pipeline.isDefault) ?? providerPipeline ?? pipelines[0];
    }

    return providerPipeline ?? pipelines.find((pipeline) => pipeline.isDefault) ?? pipelines[0];
  }

  private mergeAudioConfig(settings: StartSessionRequest['audioSettings']): AudioConfig {
    return {
      ...DEFAULT_AUDIO_CONFIG,
      sampleRate: settings.sampleRate,
      format: settings.format,
      channels: settings.channels,
      bitDepth: settings.bitDepth,
      chunkSize: settings.chunkSize,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
    };
  }
}
