import {
  AiModelDownloadService,
  AiModelService,
  CreateModelRequest,
  HttpMethod,
  ModelDownloadStatusResponse,
  ModelInventoryReport,
  ModelInventoryService,
  ModelResponse,
  PaginatedModelResponse,
  PaginatedQuery,
  SetPlatformDefaultRequest,
  TriggerModelDownloadResponse,
  UpdateModelRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  @ApiResponse({ status: 403, description: 'Platform administrators only.' })
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
  @ApiResponse({ status: 403, description: 'Platform administrators only.' })
  async lastInventory(): Promise<ModelInventoryReport | null> {
    return this.modelInventoryService.getLastReport();
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
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 409, description: 'A download for this model is already in progress' })
  async triggerDownload(@Param('id') id: string): Promise<TriggerModelDownloadResponse> {
    return this.aiModelDownloadService.triggerDownload(id);
  }

  /** Poll the status of the most recent download job for this model. */
  @Get(':id/download')
  @ApiOperation({ summary: 'Poll the status of the most recent download job for this model.' })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 200, type: ModelDownloadStatusResponse })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async getDownloadStatus(@Param('id') id: string): Promise<ModelDownloadStatusResponse> {
    return this.aiModelDownloadService.getDownloadStatus(id);
  }
}
