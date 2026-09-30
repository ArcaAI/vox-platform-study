import {
  AiModelDownloadService,
  AiModelService,
  CreateModelRequest,
  DownloadMissingResponse,
  HttpMethod,
  HubPreviewQuery,
  HubPreviewResponse,
  ModelDownloadStatusResponse,
  ModelInventoryReport,
  ModelInventoryService,
  ModelRegistryAccessResponse,
  ModelRegistryAccessService,
  ModelRegistryOperationsService,
  ModelResponse,
  ModelUsageResponse,
  PaginatedModelResponse,
  PaginatedQuery,
  PaginatedRegisteredModelViewResponse,
  RegisterFromHubRequest,
  RegisterFromHubResponse,
  SetPlatformDefaultRequest,
  TriggerModelDownloadResponse,
  UnregisterModelRequest,
  UnregisterModelResponse,
  UpdateModelRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Admin AI model registry controller (TASK-860).
 *
 * Mirrors `audio-pipeline.controller.ts` 1:1: a thin delegation surface over
 * `AiModelService` (catalogue CRUD + the platform-default election),
 * `AiModelDownloadService` (publish-to-bucket) and `ModelInventoryService`
 * (measured availability + "in bucket, not registered").
 *
 * Authorization: the registry is a SUPER_ADMIN plane — the guard is pinned
 * to `manage:all` and the service ALSO asserts a platform admin on every
 * write (403). Rows live only in the SYSTEM tenant; a super admin's working
 * tenant never changes what this controller reads or writes. OCC is enforced
 * via the `If-Match` header on the field edit.
 *
 * AUTH-NOTE: the bucket and cross-tenant operations — download, the inventory,
 * Hub preview / register, usage, unregister, download-missing — are gated
 * IMPERATIVELY in their services beyond `manage:all`: a SUPER_ADMIN with NO
 * working tenant (403 otherwise), the model-residency shape. They publish to
 * or delete from the bucket every tenant's workloads load from, and read
 * referrers across every tenant.
 *
 * AUTH-NOTE: two routes are NOT platform-only — `GET access` and `GET registry`
 * override the class-level `manage:all` with a METHOD-level `read:AiModel`
 * (the guards resolve `getAllAndOverride([handler, class])`), because every
 * tenant admin may see the registered models read-only. `registry` returns a
 * REDACTED row (descriptive columns + a one-word status), never the full one.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-model:manage')
@Controller('admin/ai-models')
@Authorize(['manage', 'all'])
export class AiModelAdminController {
  constructor(
    private readonly aiModelService: AiModelService,
    private readonly aiModelDownloadService: AiModelDownloadService,
    private readonly modelInventoryService: ModelInventoryService,
    private readonly registryOperations: ModelRegistryOperationsService,
    private readonly registryAccess: ModelRegistryAccessService,
  ) {}

  /**
   * Measure every catalogue row against the `hope-models` bucket and list the
   * manifest-bearing prefixes no row references. Synchronous (one bucket
   * listing + one manifest read per published row); returns the report.
   * Static path — registered BEFORE the `:id` family below so it is never
   * captured as `id="inventory"`.
   */
  @Post('inventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the model-bucket inventory',
    description:
      "Verifies every registry row's `bucketPrefix` + `manifestDigest` + manifest objects against `s3://hope-models`, writes the " +
      'measured `availability` (AVAILABLE / MISSING / PARTIAL / NOT_APPLICABLE) back, and lists the prefixes in the bucket that no row ' +
      'references ("In bucket, not registered → Register"). The same sweep runs hourly when `modelRegistry.inventory.enabled` is on.',
  })
  @ApiResponse({ status: 200, type: ModelInventoryReport })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 502, description: 'The bucket could not be listed — nothing was marked.' })
  async runInventory(): Promise<ModelInventoryReport> {
    return this.modelInventoryService.runInventory();
  }

  /**
   * The LAST inventory report, without running a new one (TASK-890 J1 MINOR-7).
   *
   * The report used to live only in the browser tab that produced it, so the
   * "In bucket, not registered → Register" drawer was disabled on a fresh load
   * and an operator had to re-run a full bucket sweep — one listing plus a
   * manifest read per published row — to see a list the platform had already
   * computed. `null` when nothing has been stored: the console says "not
   * measured" rather than rendering a fabricated empty bucket.
   *
   * Static path, registered BEFORE the `:id` family below for the same reason
   * the POST above is.
   */
  @Get('inventory')
  @ApiOperation({
    summary: 'Read the last model-bucket inventory report',
    description:
      'Returns the most recent `POST admin/ai-models/inventory` result without measuring anything — the availability verdicts and the ' +
      'manifest-bearing bucket prefixes no registry row references. `null` when no run has been stored (the hourly sweep is off and ' +
      'nobody has run one, or the stored report has expired). Read-only: it never lists the bucket and never writes `availability`.',
  })
  @ApiResponse({ status: 200, type: ModelInventoryReport })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  async lastInventory(): Promise<ModelInventoryReport | null> {
    return this.modelInventoryService.getLastReport();
  }

  /**
   * Read a Hugging Face repo's card and file list and suggest how to register it.
   * Static path — registered before the `:id` family.
   */
  @Get('hub/preview')
  @ApiOperation({
    summary: 'Preview a Hugging Face model before registering it',
    description:
      'Reads the repo card and file list at `revision` (default `main`) and returns what registering it would record: the commit it ' +
      'resolves to, task, library, licence, whether it is gated, languages, total size and every file — plus suggested registry ' +
      'fields (slug, name, task, category, format, serving library, bucket layout, serving workload). Nothing is written. Gated and ' +
      'private repos are read with the platform Hugging Face token.',
  })
  @ApiResponse({ status: 200, type: HubPreviewResponse })
  @ApiResponse({ status: 400, description: 'The repo id or revision is malformed.' })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Hugging Face has no such repo at that revision.' })
  @ApiResponse({
    status: 422,
    description:
      '`HF_TOKEN_REQUIRED` — the repo is gated or private (or does not exist) and no platform Hugging Face token is configured; ' +
      '`HF_TOKEN_REJECTED` — the configured token cannot read it.',
  })
  @ApiResponse({ status: 502, description: 'Hugging Face could not be reached.' })
  async previewHub(@Query() query: HubPreviewQuery): Promise<HubPreviewResponse> {
    return this.registryOperations.previewHub(query);
  }

  /**
   * Register a Hugging Face repo and start downloading it, in one call.
   */
  @Post('register-from-hub')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Register a model from a Hugging Face repo and download it',
    description:
      'Creates a platform model row from the repo (source `hf:<repo>`, pinned to the commit the revision resolves to), with the ' +
      'same validation as registering a model by hand, then starts downloading its weights into the models bucket. Any field ' +
      'in the body overrides what the preview suggests. Answers as soon as the download is queued; poll ' +
      '`GET admin/ai-models/:id/download` for progress.',
  })
  @ApiResponse({ status: 202, type: RegisterFromHubResponse })
  @ApiResponse({
    status: 400,
    description: 'The resulting registration is invalid — for example no serving library could be inferred and none was given.',
  })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Hugging Face has no such repo at that revision.' })
  @ApiResponse({ status: 409, description: '`SLUG_TAKEN` — a model with that slug is already registered.' })
  @ApiResponse({ status: 422, description: '`HF_TOKEN_REQUIRED` / `HF_TOKEN_REJECTED` — as for the preview.' })
  async registerFromHub(@Body() request: RegisterFromHubRequest): Promise<RegisterFromHubResponse> {
    return this.registryOperations.registerFromHub(request);
  }

  /**
   * Queue a download for every platform model whose weights are missing from the bucket.
   */
  @Post('download-missing')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Download every model whose weights are missing',
    description:
      'Queues a download for each self-hosted platform model the last inventory measured as MISSING and whose source can be ' +
      'fetched (a Hugging Face repo or an `s3://` prefix). Models already downloading or being unregistered are skipped, and ' +
      'every skip says why. Use it to fill an empty models bucket on a new cluster.',
  })
  @ApiResponse({ status: 202, type: DownloadMissingResponse })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  async downloadMissing(): Promise<DownloadMissingResponse> {
    return this.registryOperations.downloadMissing();
  }

  /**
   * What the caller may do on the model registry: whether they may manage it,
   * and whether tenant management is switched on for their tenant.
   */
  @Get('access')
  @Authorize(['read', 'AiModel'])
  @RequiredSvcScopes('svc:admin:ai-model:read', 'svc:admin:ai-model:manage')
  @ApiOperation({
    summary: 'Your access to the model registry',
    description:
      '`canManage` is true only for a platform administrator with no working tenant selected — the only caller who may register, ' +
      'edit, download or unregister models. `tenantManagementEnabled` is the effective `modelRegistry.tenantManagement.enabled` ' +
      "setting for the caller's tenant; it is reported for information and does not let a tenant administrator change the registry.",
  })
  @ApiOkResponse({ type: ModelRegistryAccessResponse })
  @ApiResponse({ status: 403, description: 'The caller does not hold `read:AiModel`, or presented an API key.' })
  async access(): Promise<ModelRegistryAccessResponse> {
    return this.registryAccess.getAccess();
  }

  /**
   * The registered platform models, read-only: descriptive columns and a
   * one-word status per model. Any administrator may read it.
   */
  @Get('registry')
  @Authorize(['read', 'AiModel'])
  @RequiredSvcScopes('svc:admin:ai-model:read', 'svc:admin:ai-model:manage')
  @ApiOperation({
    summary: 'List the registered models (read-only)',
    description:
      'One page of the platform model registry as any administrator may see it: name, task, runtime, format, serving service, ' +
      'license, languages, memory footprint, platform-default tasks and a one-word lifecycle status (for example `SERVING` or ' +
      '`DOWNLOADED`). Storage locations, checksums, per-service placement, usage and job errors are not included. Takes the same ' +
      '`page`, `limit`, `search`, `searchFields`, `filters` and `sort` parameters as `GET admin/ai-models/list`, but they may only ' +
      'name the columns this view returns.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (1-based).' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10).' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Free-text term matched against `searchFields`.' })
  @ApiQuery({ name: 'searchFields', required: false, type: String, description: 'Comma-separated columns the `search` term targets, e.g. `name,slug`.' })
  @ApiQuery({
    name: 'filters',
    required: false,
    type: String,
    description: "';'-separated `field[op]:value` tokens over this view's columns, e.g. `taskType[equals]:AUTOMATIC_SPEECH_RECOGNITION`.",
  })
  @ApiQuery({ name: 'sort', required: false, type: String, description: 'Comma-separated `field:asc|desc`. Defaults to `name:asc`.' })
  @ApiOkResponse({ type: PaginatedRegisteredModelViewResponse })
  @ApiResponse({ status: 400, description: 'Malformed pagination or filter, or a filter, search field or sort naming a column this view does not return.' })
  @ApiResponse({ status: 403, description: 'The caller does not hold `read:AiModel`, or presented an API key.' })
  async registry(@Query() query: PaginatedQuery): Promise<PaginatedRegisteredModelViewResponse> {
    return this.aiModelService.listRegistry(query);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - duplicate slug' })
  async create(@Body() request: CreateModelRequest): Promise<ModelResponse> {
    return this.aiModelService.create(request);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    multi: true,
  })
  async fetchAll(): Promise<ModelResponse[]> {
    // The admin surface lists models of ALL statuses (ENABLED + DISABLED) for
    // the EXACT caller tenant: a disabled model stays
    // visible/re-enableable, and a tenant admin sees only its own clone — never
    // the SYSTEM original. The public, enabled-only `getAll` is unaffected.
    return this.aiModelService.getAllForAdmin();
  }

  /**
   * List the SYSTEM model registry as one paginated page. The whole query object
   * is bound (`search`, `searchFields`, `filters`, `sort`, `page`, `limit`) so
   * the grid's parameters reach the service and undeclared ones are rejected by
   * the global validation pipe; named `@Query('x')` bindings would silently drop
   * everything but the named keys.
   */
  @ApiEndpoint({
    returnedModel: PaginatedModelResponse,
    path: 'list',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number. The list contract is 1-based (`skip = (page - 1) * limit`); 0 and 1 both select the first page.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10)' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Free-text term matched against `searchFields` (case-insensitive contains).',
  })
  @ApiQuery({
    name: 'searchFields',
    required: false,
    type: String,
    description: 'Comma-separated columns the `search` term targets — the registry grid sends `name,slug`. Without it, `search` matches nothing.',
  })
  @ApiQuery({
    name: 'filters',
    required: false,
    type: String,
    description:
      "';'-separated `field[op]:value` tokens, e.g. `deploymentKind[in]:CLOUD|SELF_HOSTED;availability[equals]:AVAILABLE`. The [operator] is " +
      'REQUIRED and the operator set is closed; an unknown operator or an invalid enum member is a 400. `tenantId` is not honoured — the ' +
      'registry is pinned to the SYSTEM tenant.',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    type: String,
    description: 'Comma-separated `field:asc|desc`, e.g. `name:desc`. Defaults to `name:asc`.',
  })
  @ApiResponse({ status: 400, description: 'Bad request — malformed pagination, filter token, or an undeclared query parameter.' })
  async list(@Query() query: PaginatedQuery): Promise<PaginatedModelResponse> {
    return this.aiModelService.list(query);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async fetchById(@Param('id') id: string): Promise<ModelResponse> {
    const model = await this.aiModelService.getById(id);
    if (!model) {
      // A null service result used to serialize as HTTP 200
      // with an EMPTY body; an absent row is a 404.
      throw new NotFoundException(`Model '${id}' not found`);
    }
    return model;
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Model slug', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<ModelResponse> {
    const model = await this.aiModelService.getBySlug(slug);
    if (!model) {
      // See fetchById: null must be a 404, not a 200-empty.
      throw new NotFoundException(`Model with slug '${slug}' not found`);
    }
    return model;
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update an AI model',
    description:
      'Updates one AiModel row. Optimistic concurrency is enforced: ' +
      'the `If-Match` header (RFC 7232) is REQUIRED, and the server ' +
      "runs a Compare-And-Set against the row's `_version` column. When the " +
      'header is present, its value overrides the body-field `expectedVersion`. ' +
      'On version drift the response is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - duplicate slug' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateModelRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ModelResponse> {
    // The header takes precedence over the body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator already fired 428 if the
    // header was missing (mirrors the pipeline OCC contract).
    const effectiveRequest: UpdateModelRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.aiModelService.update(id, effectiveRequest);
  }

  /**
   * The super-admin "platform default for task" election (TASK-860 §3.7).
   * Not an OCC field edit — it also clears each task from its previous holder —
   * so it has its own route and no `If-Match`; the service CASes on the
   * current row versions and a concurrent edit still surfaces as 412.
   */
  @Patch(':id/platform-default')
  @ApiOperation({
    summary: 'Elect this row as the platform default for one or more tasks',
    description:
      "Replaces the row's `isPlatformDefaultFor` with `tasks` and clears each of those tasks from whichever ENABLED row held it, so a " +
      'task never has two platform defaults. An empty list withdraws the row from every election. Only writes the registry column and ' +
      'emits a sys-event; the SYSTEM routing-policy election it seeds is TASK-862.',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 200, type: ModelResponse })
  @ApiResponse({ status: 400, description: 'The row is not ENABLED.' })
  @ApiResponse({ status: 403, description: 'Platform administrators only.' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 412, description: 'A concurrent edit moved one of the rows — re-fetch and try again.' })
  async setPlatformDefault(@Param('id') id: string, @Body() request: SetPlatformDefaultRequest): Promise<ModelResponse> {
    return this.aiModelService.setPlatformDefaultFor(id, request);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.aiModelService.delete(id);
  }

  /**
   * Trigger an async download of this model's weights from its current
   * `sourceUri` (a HuggingFace repo id or an `s3://` prefix) into the
   * `hope-models` bucket. Long work runs on the `DownloadAiModel` BullMQ
   * queue — this returns as soon as the row is flipped to DOWNLOADING and
   * the job is enqueued, never after the transfer completes.
   *
   * Plain `@Post`/`@HttpCode` (not `@ApiEndpoint`) because the success status
   * is `202 Accepted`, not `@ApiEndpoint`'s default `201` — same pattern as
   * `WorkflowSandboxRunController.start`.
   */
  @Post(':id/download')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Publish this model's weights into the hope-models bucket (async).",
    description:
      'Fetches the weights from `sourceUri` (Hub or s3://), verifies + content-addresses them, publishes them under `<slug>/<version>/` ' +
      '(or as a verbatim HF cache for the transformers family), and writes `bucketPrefix` / `manifestDigest` / `availability` back to the row. ' +
      "The route path keeps its frozen `download` name; the action is the registry's single publisher (TASK-860 D-1).",
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 202, type: TriggerModelDownloadResponse })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 409, description: 'A download for this model is already in progress, or the model is being unregistered' })
  async triggerDownload(@Param('id') id: string): Promise<TriggerModelDownloadResponse> {
    return this.aiModelDownloadService.triggerDownload(id);
  }

  /**
   * Everything that still references this model, across all tenants.
   */
  @Get(':id/usage')
  @ApiOperation({
    summary: 'List what still uses this model',
    description:
      'Every agent (primary model, fallback, or an ASR sub-model such as the VAD or speaker-embedding model), routing policy, ' +
      'residency policy and voice profile that references the model, in every tenant. A model with any referrer cannot be ' +
      'unregistered; this is the list the refusal carries.',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 200, type: ModelUsageResponse })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async getUsage(@Param('id') id: string): Promise<ModelUsageResponse> {
    return this.registryOperations.getUsage(id);
  }

  /**
   * Unregister a model and (by default) delete its weights from the models bucket.
   */
  @Post(':id/unregister')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Unregister a model and delete its weights',
    description:
      'Refused while anything still uses the model (see `GET :id/usage`). Otherwise the model is first unloaded from every service ' +
      'holding it, then marked UNREGISTERING and removed by the model publisher: the row is retired and — unless ' +
      '`deleteWeights` is false or another registered model shares the same files — its weights are deleted from the bucket. ' +
      'Deleted weights stay recoverable for 30 days unless `purge` is true.',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 202, type: UnregisterModelResponse })
  @ApiResponse({ status: 400, description: 'The body is malformed.' })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({
    status: 409,
    description:
      '`MODEL_IN_USE` (with `referrers`), `MODEL_UNLOAD_FAILED` (still loaded somewhere, with `services`), `MODEL_UNREGISTERING`, ' +
      '`DOWNLOAD_IN_PROGRESS`, or `MODEL_CHANGED` (edited concurrently — retry).',
  })
  async unregister(@Param('id') id: string, @Body() request: UnregisterModelRequest): Promise<UnregisterModelResponse> {
    return this.registryOperations.unregister(id, request ?? {});
  }

  /** Poll the status of the most recent download job for this model. */
  @Get(':id/download')
  @ApiOperation({ summary: 'Poll the status of the most recent download job for this model.' })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 200, type: ModelDownloadStatusResponse })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async getDownloadStatus(@Param('id') id: string): Promise<ModelDownloadStatusResponse> {
    return this.aiModelDownloadService.getDownloadStatus(id);
  }
}
