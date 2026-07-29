import { Authorize, IApiKeyService, PipelineService, StreamingSessionService } from '@arcaai/applications';
import { BadRequestException, Body, Controller, HttpCode, Inject, Optional, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { StreamSessionTenantBindingService } from '../../common';
import { StartSessionRequest } from './dto/start-session.request';
import { SttCompatSessionMetadataService } from './stt-compat-session-metadata.service';
import type { AudioConfig, StartSessionResponse } from './dto/start-session.response';
import { StopSessionRequest } from './dto/stop-session.request';
import type { StopSessionResponse } from './dto/stop-session.response';

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
export class SttCompatController {
  constructor(
    @Optional() private readonly pipelineService?: PipelineService,
    @Optional() private readonly sessionService?: StreamingSessionService,
    @Optional() private readonly sessionBinding?: StreamSessionTenantBindingService,
    @Optional() private readonly cls?: ClsService,
    @Optional() @Inject(IApiKeyService) private readonly apiKeyService?: IApiKeyService,
    @Optional() private readonly sessionMetadataService?: SttCompatSessionMetadataService,
  ) {}

  @Post('start_session')
  @Authorize()
  @ApiOperation({ summary: 'v1-compatible STT session start' })
  async startSession(
    @Body() body: StartSessionRequest,
    @Req()
    request: {
      apiKey?: { tenantId?: string; userId?: string };
      user?: { id?: string; tenantId?: string };
      headers?: Record<string, string | string[] | undefined>;
    } = {},
  ): Promise<StartSessionResponse> {
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

    const user = request.user ?? this.cls?.get<{ id?: string; tenantId?: string }>('user');
    const rawApiKeyHeader = request.headers?.['x-api-key'];
    const rawApiKey = Array.isArray(rawApiKeyHeader) ? rawApiKeyHeader[0] : rawApiKeyHeader;
    const authenticatedKey = rawApiKey && this.apiKeyService ? await this.apiKeyService.authenticateByRawKey(rawApiKey, undefined) : undefined;
    const tenantId = user?.tenantId ?? request.apiKey?.tenantId ?? authenticatedKey?.tenantId ?? this.cls?.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelineService = this.pipelineService;
    const sessionService = this.sessionService;
    const sessionBinding = this.sessionBinding;
    const createSession = async (): Promise<StartSessionResponse> => {
      const pipelines = await pipelineService.getAll();
      const pipeline = this.selectPipeline(pipelines, provider);
      if (!pipeline) {
        throw new BadRequestException('No STT pipeline is configured for this tenant');
      }

      const session = await sessionService.createSession({
        sessionId: body.session_id,
        tenantId,
        pipelineId: pipeline.id,
        sampleRate: body.audioSettings.sampleRate,
        userId: user?.id ?? request.apiKey?.userId ?? authenticatedKey?.userId,
        language: body.language ?? undefined,
      });
      if (!session) {
        throw new BadRequestException('STT streaming service is at capacity');
      }

      await Promise.all([
        sessionBinding.bind(body.session_id, tenantId),
        sessionBinding.bindSessionMeta(body.session_id, { sampleRate: body.audioSettings.sampleRate }),
        this.sessionMetadataService?.setLanguage(body.session_id, body.language),
      ]);

      return response;
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

  @Post('stop_session')
  @HttpCode(200)
  @Authorize()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'v1-compatible STT session stop' })
  @UseInterceptors(FileInterceptor('audio_file'))
  async stopSession(@UploadedFile() audioFile: Express.Multer.File | undefined, @Body() body: StopSessionRequest): Promise<StopSessionResponse> {
    if (this.sessionService && this.sessionBinding) {
      await this.sessionService.removeSession(body.session_id);
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
