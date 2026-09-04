import {
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  IActiveUserContext,
  InternalCompleteJobRequest,
  InternalCreateMediaRequest,
  InternalFailJobRequest,
  InternalStartJobRequest,
  InternalUpdateProgressRequest,
  IProviderConnectionService,
  ITenantSttConfigService,
  SecretsService,
  StreamingSessionService,
  SttInternalService,
} from '@arcaai/applications';
import type { ResolvedProviderCredential, SttProviderOverrides, StreamingSessionTeardownSummary } from '@arcaai/applications';
import { SttStreamingUsagePushbackRequest } from './dto/stt-streaming-usage.request';
import { resolveModelRegistryCredential } from './model-registry-credential.util';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { timingSafeEqual } from 'node:crypto';
import { Authorize, RequiredScopes } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';

@ApiTags('internal-stt')
@ApiExcludeController()
@ApiSecurity('api-key')
@Authorize()
// Gap closed: previously this class had no `@RequiredScopes`, so
// `UnifiedAuthGuard.enforceApiKeyScopes` saw no metadata and skipped the
// check entirely — see the AUTH-NOTE below on `assertPlatformInternalCredential`
// for what that meant in practice. `internal:stt:worker` is a reserved scope
// (`apikey-scopes.registry.ts`) never issued to a tenant SDK/WEBHOOK/INTEGRATION
// key; the STT worker's platform SERVICE_ACCOUNT credential (scopes: `['*']`)
// satisfies it via the existing wildcard grant, so this is unaffected for the
// worker and closes the gap for every other API-key holder.
@RequiredScopes('internal:stt:worker')
// API-KEY-NOTE — RESERVED-SCOPE CARVE-OUT (BUG-013). SETTLED, AND POLICED AT BOOT.
// This is the ONLY `/internal/*` controller on the API-key path. The other four
// (`EffectiveConfigController`, `HarnessInternalController`,
// `ConsentInternalController`, `ServiceReleaseInternalController`) are
// `@Public()` + a service-token guard. That asymmetry reads as drift and is not:
// the STT worker authenticates with `X-Internal-Service-Key` carrying the RAW
// value of a registered ACTIVE SERVICE_ACCOUNT `ApiKey` row (BUG-013) — see
// `apps/stt/src/stt/core/api_client/gateway.py` and `core/effective_config.py`.
// It presents an API KEY, not a service token, so pulling this controller off
// the API-key surface would break the worker unless `apps/stt` changed in
// lockstep, and `assertPlatformInternalCredential` below depends on that same
// API-key identity for the cross-tenant `X-Internal-Tenant-Id` pin.
// The exemption is enforced, not merely written down: `auditInternalRoutesOffApiKeySurface`
// (`apps/api/src/bootstrap/api-key-scope-audit.ts`, `RESERVED_INTERNAL_SCOPE_CONTROLLERS`)
// fails BOOT if this class stops carrying an `internal:`-rooted `@RequiredScopes`
// — proven by `api-key-scope-audit.test.ts`'s "carve-out is policed, not a hole"
// case. Do not "converge" this onto a service-token guard without changing
// `apps/stt` in the same commit. Recorded in `docs/architecture/api-controller-inventory.md`
@Controller('internal/stt')
export class SttInternalController {
  constructor(
    private readonly sttInternalService: SttInternalService,
    // Resolves a tenant's decrypted BYO provider overrides for the batch-worker
    // PULL path. Optional so positional test construction still
    // works; the pull route rejects (500-class) when unwired in prod.
    @Optional() @Inject(ITenantSttConfigService) private readonly sttConfig?: ITenantSttConfigService,
    // Re-establishes a SYSTEM-free CLS tenant context around the tenant-scoped
    // credential read (service-to-service calls carry no user/tenant CLS).
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // Verifies the platform internal credential before a caller-supplied
    // `X-Internal-Tenant-Id` is honoured (BUG-013 — see `assertPlatformInternalCredential`).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Records the reaper-built usage summary on the STT-side push-back path
    // . Optional so positional test construction still works.
    @Optional() private readonly streamingSession?: StreamingSessionService,
    // backs `model-registry-credential`, the weight fetcher's only
    // route to the HuggingFace token and the model-store S3 pair. Optional and
    // TRAILING so existing positional test construction is unaffected.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
  ) {}

  /** The secret the STT worker presents as `X-Internal-Service-Key`. */
  private static readonly INTERNAL_GATEWAY_SECRET = 'API_GATEWAY_KEY';

  /**
   * BUG-013 — run `work` with CLS pinned to the tenant the caller addressed.
   *
   * The STT worker is ONE platform-wide process servicing every tenant's queue
   * from ONE credential, so the tenant cannot be derived from the credential:
   * `UnifiedAuthGuard` sets CLS `tenantId` from the API-key row (pinned to the
   * platform default tenant), and `TranscriptionJob` is tenant-scoped, so a job
   * owned by any other tenant is filtered out of `findById` and the callback
   * 404s. Since `/fail` failed the same way, such a job could never even be
   * marked FAILED — it stranded at QUEUED with no error.
   *
   * The tenant-scope extension deliberately stays ON: the lookup still filters
   * by `tenantId`, so a callback naming the WRONG tenant still gets a 404 rather
   * than someone else's row (404-over-403 posture preserved).
   *
   * The header is `X-Internal-Tenant-Id`, NOT `X-Tenant-Id`: the global
   * `ContextInterceptor` rejects an `x-tenant-id` that diverges from the
   * authenticated principal's tenant with a 400, and the worker's API-key row
   * carries a `userId`, so CLS *does* hold a user and that guard *does* fire —
   * the request never reaches this method. A distinct internal-only header keeps
   * the console's `x-tenant-id` semantics (and their guard) untouched.
   *
   * No header ⇒ unchanged behaviour, so an un-upgraded worker keeps working.
   */
  private async runTenantPinned<T>(request: RequestWithAuth, tenantId: string | undefined, work: () => Promise<T>): Promise<T> {
    const pinned = tenantId?.trim();
    if (!pinned) {
      return work();
    }

    await this.assertPlatformInternalCredential(request);

    if (!this.cls) {
      throw new BadRequestException('Tenant-pinned internal STT calls are not supported on this gateway');
    }

    return this.cls.run(async () => {
      this.cls!.set('tenantId', pinned);
      return work();
    });
  }

  /**
   * AUTH-NOTE: the class-level `@RequiredScopes('internal:stt:worker')` now
   * gates entry to this whole controller — an ordinary tenant SDK/WEBHOOK/
   * INTEGRATION key no longer reaches ANY route here, because that scope is
   * reserved and never issued to a tenant key (`apikey-scopes.registry.ts`).
   * Only a caller holding it (in practice, the platform SERVICE_ACCOUNT
   * credential, scopes `['*']`) gets this far at all.
   *
   * `ensureInternalApiKey` still just checks `request.apiKey` is set (i.e.
   * the caller authenticated via API key, not JWT) — it does not itself
   * distinguish which key. This method is the SECOND, narrower gate: even
   * among callers that clear `@RequiredScopes`, honouring a caller-supplied
   * `X-Internal-Tenant-Id` would hand a tenant selector to whoever holds it,
   * so the cross-tenant pin is admitted ONLY for a caller presenting the
   * platform internal credential (`X-Internal-Service-Key` === `API_GATEWAY_KEY`,
   * the same secret/header pairing `InternalServiceTokenGuard` maps for `stt`),
   * compared in constant time. Fails CLOSED when the secret is unresolvable.
   *
   * This is a 403 privilege boundary, NOT the 404-over-403 cross-tenant posture:
   * a wrong-but-authorised tenant id still yields a 404 from the scoped lookup.
   */
  private async assertPlatformInternalCredential(request: RequestWithAuth): Promise<void> {
    const rawHeader = request.headers?.['x-internal-service-key'];
    const presented = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const expected = await this.secretsService?.getSecretOptional(SttInternalController.INTERNAL_GATEWAY_SECRET);
    if (!expected) {
      throw new ForbiddenException('Tenant-scoped internal STT calls are not configured on this gateway');
    }

    if (!presented || !safeEqual(presented, expected)) {
      throw new ForbiddenException('X-Internal-Tenant-Id is honoured only for the platform internal STT credential');
    }
  }

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
    // BUG-013: the batch path resolves the job by id under the tenant-scoped
    // extension, so this create needs the same tenant addressing as /start.
    @Headers('x-internal-tenant-id') tenantId?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.createTranscript(dto, idempotencyKey));
  }

  @Post('streaming/usage')
  @ApiOperation({
    summary: 'Record streaming usage from an STT-side reaper finalize (#13 push-back)',
    description:
      'The STT inactivity reaper POSTs the teardown summary it built for a session whose gateway caller crashed and whose ' +
      'removal retries were exhausted, so the transcribe.stream usage is still metered. Idempotent on the session id.',
  })
  async recordStreamingUsage(@Req() request: RequestWithAuth, @Body() dto: SttStreamingUsagePushbackRequest): Promise<{ recorded: boolean }> {
    this.ensureInternalApiKey(request);
    const { interrupted, ...summary } = dto;
    await this.streamingSession?.recordStreamingUsageFromSummary(summary as unknown as StreamingSessionTeardownSummary, interrupted);
    return { recorded: true };
  }

  @Patch('jobs/:id/start')
  @ApiOperation({ summary: 'Mark transcription job as PROCESSING' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async startJob(
    @Req() request: RequestWithAuth,
    @Param('id') id: string,
    @Body() dto: InternalStartJobRequest,
    @Headers('x-internal-tenant-id') tenantId?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.startJob(id, dto));
  }

  @Patch('jobs/:id/progress')
  @ApiOperation({ summary: 'Update transcription job progress' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async updateProgress(
    @Req() request: RequestWithAuth,
    @Param('id') id: string,
    @Body() dto: InternalUpdateProgressRequest,
    @Headers('x-internal-tenant-id') tenantId?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.updateProgress(id, dto));
  }

  @Patch('jobs/:id/complete')
  @ApiOperation({ summary: 'Mark transcription job as COMPLETED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async completeJob(
    @Req() request: RequestWithAuth,
    @Param('id') id: string,
    @Body() dto: InternalCompleteJobRequest,
    @Headers('x-internal-tenant-id') tenantId?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.completeJob(id, dto));
  }

  @Patch('jobs/:id/fail')
  @ApiOperation({ summary: 'Mark transcription job as FAILED' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async failJob(
    @Req() request: RequestWithAuth,
    @Param('id') id: string,
    @Body() dto: InternalFailJobRequest,
    @Headers('x-internal-tenant-id') tenantId?: string,
  ) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.failJob(id, dto));
  }

  @Get('jobs/:id/status')
  @ApiOperation({ summary: 'Get job status (lightweight, for worker polling)' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async getJobStatus(@Req() request: RequestWithAuth, @Param('id') id: string, @Headers('x-internal-tenant-id') tenantId?: string) {
    this.ensureInternalApiKey(request);
    return this.runTenantPinned(request, tenantId, () => this.sttInternalService.getJobStatus(id));
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
   * The batch-worker PULL path for BYO provider credentials.
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
  /**
   * resolve ONE `model-registry` credential for the STT weight fetcher.
   *
   * SUPERSEDED ( follow-on) by the generic
   * `GET /internal/model-registry-credential`
   * (`ModelRegistryInternalController`), which every backend service —
   * including STT — can reach. This path is kept ALIVE, not retired: the STT
   * worker calls it in production today
   * (`apps/stt/src/stt/core/api_client/gateway.py`), and retiring it needs
   * the worker migrated to the generic route FIRST, in its own change — never
   * remove this method to "tidy up" without that migration landing.
   *
   * `HUGGINGFACE_TOKEN` and the `STT_MODEL_S3_*` pair were the last two
   * credentials this service read from the environment. They now live on
   * `AiProviderConnection` under `service = 'model-registry'`, and this is how
   * the worker reaches them: it holds no DB handle, and a model load is not an
   * inbound gateway request, so nothing can be folded into a request envelope.
   *
   * WHOSE credential is spent is decided by the MODEL ROW'S OWNER, never the
   * caller. `tenantId` here is `AiModel.tenantId` — a SYSTEM-owned model always
   * resolves the platform's token, so one tenant can never cause another's
   * token to be spent, and a shared in-process weight cache stays safe. The
   * worker passes SYSTEM explicitly for a platform model rather than omitting
   * the parameter; there is no tenant-less form.
   *
   * Distinct from `provider-overrides` above in BOTH shape and failure
   * direction: that route returns a whole-service map and fails OPEN (a broken
   * BYO ASR key drops out and transcription proceeds on the platform's). This
   * one returns a single four-outcome verdict and the consumer fails CLOSED on
   * `denied`/`unavailable`, because after the env paths are closed there is no
   * longer anything to fall back TO — and a fault silently read as "no
   * credential configured" would downgrade an entitled pull to an anonymous one.
   *
   * The body itself is NOT duplicated — both this route and the generic one
   * delegate to `resolveModelRegistryCredential()`
   * (`model-registry-credential.util.ts`). Only the guard differs: this route
   * stays on `SttInternalController`'s reserved-API-key-scope posture
   * (`ensureInternalApiKey` + the class-level `@RequiredScopes`); the guard
   * itself is untouched by this change.
   */
  @Get('model-registry-credential')
  @ApiOperation({
    summary:
      'Resolve one model-registry credential (tenant → SYSTEM) for the STT weight fetcher. Superseded by GET /internal/model-registry-credential.',
  })
  async getModelRegistryCredential(
    @Req() request: RequestWithAuth,
    @Query('provider') provider?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<ResolvedProviderCredential> {
    this.ensureInternalApiKey(request);
    return resolveModelRegistryCredential(this.providerConnections, this.cls, provider, tenantId);
  }

  /**
   * TASK-861: still the batch worker's credential pull on the agent path too —
   * the Dramatiq message carries `resolved_spec` (never a key), so the worker
   * fetches the tenant's cloud credentials here at execution time. Backed by the
   * deprecated `TenantSttConfigService.resolveProviderOverrides`; repointing it
   * onto `ProviderCredentialResolver` is a follow-up (the wire shape is identical).
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

/** Constant-time comparison that short-circuits safely on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
