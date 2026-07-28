import {
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  IActiveUserContext,
  InternalCompleteJobRequest,
  InternalCreateMediaRequest,
  InternalFailJobRequest,
  InternalStartJobRequest,
  InternalUpdateProgressRequest,
  ITenantSttConfigService,
  SttInternalService,
} from '@arcaai/applications';
import type { SttProviderOverrides } from '@arcaai/applications';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';

@ApiTags('internal-stt')
@ApiExcludeController()
@ApiSecurity('api-key')
@Authorize()
@Controller('internal/stt')
export class SttInternalController {
  constructor(
    private readonly sttInternalService: SttInternalService,
    // Resolves a tenant's decrypted BYO provider overrides for the batch-worker
    // PULL path (TASK-567 D-3). Optional so positional test construction still
    // works; the pull route rejects (500-class) when unwired in prod.
    @Optional() @Inject(ITenantSttConfigService) private readonly sttConfig?: ITenantSttConfigService,
    // Re-establishes a SYSTEM-free CLS tenant context around the tenant-scoped
    // credential read (service-to-service calls carry no user/tenant CLS).
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
  ) {}

  // Typed `RequestWithAuth` replaces the earlier
  // `request['apiKey']` bracket lookup. The typed dot-access means a
  // typo (`request.aip_key`) now fails TypeScript instead of silently
  // resolving to `undefined` and bypassing the API-key gate below.
  private ensureInternalApiKey(request: RequestWithAuth): void {
    if (!request.apiKey) {
      throw new UnauthorizedException('Internal STT endpoints require API key authentication');
    }
  }

  @Post('transcripts')
  @ApiOperation({ summary: 'Create transcript context item from STT worker output' })
  async createTranscript(
    @Req() request: RequestWithAuth,
    @Body() dto: CreateTranscriptRequest,
    // STT-v2 sends a forward-compatible `Idempotency-Key` header
    // (`{consultationId}:{sessionId}`) on this call (`gateway.py`); read it
    // through so the streaming-transcript create path can dedup a concurrent
    // finalize race instead of silently creating a duplicate ContextItem (F-09).
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.createTranscript(dto, idempotencyKey);
  }

  @Patch('jobs/:id/start')
  @ApiOperation({ summary: 'Mark transcription job as PROCESSING' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async startJob(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() dto: InternalStartJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.startJob(id, dto);
  }

  @Patch('jobs/:id/progress')
  @ApiOperation({ summary: 'Update transcription job progress' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async updateProgress(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() dto: InternalUpdateProgressRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.updateProgress(id, dto);
  }

  @Patch('jobs/:id/complete')
  @ApiOperation({ summary: 'Mark transcription job as COMPLETED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async completeJob(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() dto: InternalCompleteJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.completeJob(id, dto);
  }

  @Patch('jobs/:id/fail')
  @ApiOperation({ summary: 'Mark transcription job as FAILED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async failJob(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() dto: InternalFailJobRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.failJob(id, dto);
  }

  @Get('jobs/:id/status')
  @ApiOperation({ summary: 'Get job status (lightweight, for worker polling)' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async getJobStatus(@Req() request: RequestWithAuth, @Param('id') id: string) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.getJobStatus(id);
  }

  @Post('audio-records')
  @ApiOperation({ summary: 'Create audio record linked to context item' })
  async createAudioRecord(@Req() request: RequestWithAuth, @Body() dto: CreateAudioRecordRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.createAudioRecord(dto);
  }

  // Register a stored object as a Media row (dual-capture).
  @Post('media')
  @ApiOperation({ summary: 'Register a stored audio object as a Media row' })
  async createMedia(@Req() request: RequestWithAuth, @Body() dto: InternalCreateMediaRequest) {
    this.ensureInternalApiKey(request);
    return this.sttInternalService.createMedia(dto);
  }

  /**
   * The batch-worker PULL path for BYO provider credentials (TASK-567 D-3).
   * Injecting a decrypted key into the Dramatiq queue message is prohibited
   * (PHI posture — secrets never at rest outside Vault ciphertext), so the
   * separate worker process pulls the tenant's decrypted overrides at execution
   * time instead. Service-to-service only (`X-Internal-Service-Key`, same gate
   * as every other route on this controller); never reachable by a browser.
   *
   * The call carries no user/tenant CLS, and the credential model is
   * tenant-scoped (its Prisma extension fails closed without a tenant context),
   * so CLS is re-established pinned to the requested tenant — the same tenant the
   * repository query filters on. Fails OPEN per credential inside the service; a
   * broken/absent key simply drops out of the map (worker falls back to env).
   */
  @Get('provider-overrides')
  @ApiOperation({ summary: 'Resolve a tenant’s decrypted BYO STT provider overrides (batch-worker pull)' })
  async getProviderOverrides(@Req() request: RequestWithAuth, @Query('tenantId') tenantId?: string): Promise<SttProviderOverrides> {
    this.ensureInternalApiKey(request);
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId query parameter is required');
    }
    if (!this.sttConfig || !this.cls) {
      throw new BadRequestException('STT provider-override resolution is not configured on this gateway');
    }
    const scopedTenantId = tenantId.trim();
    return this.cls.run(async () => {
      this.cls!.set('tenantId', scopedTenantId);
      return this.sttConfig!.resolveProviderOverrides(scopedTenantId);
    });
  }
}
