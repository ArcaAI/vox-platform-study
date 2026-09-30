import {
  AiModelService,
  ModelCatalogueQuery,
  ModelCatalogueResponse,
  ModelRegistryAccessResponse,
  ModelRegistryAccessService,
  PaginatedQuery,
  PaginatedRegisteredModelViewResponse,
} from '@arcaai/applications';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * The TENANT-facing model catalogue (TASK-890 §3.7).
 *
 * ## Why this is its own controller
 *
 * `AiModelAdminController` is a SUPER_ADMIN plane: class-level
 * `@Authorize(['manage','all'])` plus a second imperative platform-admin
 * assertion on every write. This route is the one thing on that surface a
 * TENANT admin must reach — the picker it binds an agent's model from — and it
 * is a pure read. Adding it to the admin controller would mean a method-level
 * override of a class-level super-admin gate, which is exactly the shape that
 * gets widened by accident later. A separate controller states the boundary in
 * the file layout: everything here is `read:AiModel`, everything there is
 * `manage:all`.
 *
 * ## Registration order
 *
 * `catalogue` is a STATIC path under `admin/ai-models`, and
 * `AiModelAdminController` carries `GET :id`. Nest matches in controller
 * registration order, so this class must be registered BEFORE it in
 * `AiModelModule` or `/catalogue` is captured as `id="catalogue"` and 404s —
 * the same rule the discovery controller already lives under.
 *
 * ## Credential classes
 *
 * `@ForbidApiKey()` — the business plane never reaches `/admin/*`. The
 * service-account pair is OR-matched, so declaring the `:read` scope beside the
 * existing `:manage` twin adds a read-only grant without revoking the route
 * from every account that already holds `:manage` (decision O-3; the precedent
 * is `ApiKeyController`'s read routes).
 *
 * TASK-1023 adds the two other routes every admin reads: `GET access` (may the
 * caller manage the registry?) and `GET registry` (the registered models,
 * REDACTED to descriptive columns + a one-word status). They live here, not on
 * the admin controller, for the same boundary reason — and because the boot
 * audit admits the `:read`+`:manage` service-account pair only off that plane.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@Controller('admin/ai-models')
export class AiModelCatalogueController {
  constructor(
    private readonly aiModelService: AiModelService,
    private readonly registryAccess: ModelRegistryAccessService,
  ) {}

  @Get('catalogue')
  @Authorize(['read', 'AiModel'])
  @RequiredSvcScopes('svc:admin:ai-model:read', 'svc:admin:ai-model:manage')
  @ApiOperation({
    summary: 'The model catalogue this tenant may bind, in picker order',
    description:
      'Two groups: the tenant’s OWN provider connections first (`byo:<service>:<provider>`), then exactly one "Hope provider" entry ' +
      'standing for everything the platform serves. Each model carries a `usable` verdict with a machine-readable reason (an unusable ' +
      'model is listed WITH its reason rather than hidden) and the last OBSERVED `readiness` — a stored snapshot, never a probe: reading ' +
      'this route never causes a vendor call. Plan entitlements BOUND the Hope group; they never add or substitute a model. Rows naming ' +
      'no servable provider are hidden, and counted in `unassignedProviderCount` for a super admin.',
  })
  @ApiOkResponse({ type: ModelCatalogueResponse })
  @ApiResponse({ status: 403, description: 'The caller does not hold `read:AiModel`, or presented an API key.' })
  async catalogue(@Query() query: ModelCatalogueQuery): Promise<ModelCatalogueResponse> {
    return this.aiModelService.getCatalogue(query);
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
  @ApiQuery({
    name: 'searchFields',
    required: false,
    type: String,
    description: 'Comma-separated columns the `search` term targets, e.g. `name,slug`.',
  })
  @ApiQuery({
    name: 'filters',
    required: false,
    type: String,
    description: "';'-separated `field[op]:value` tokens over this view's columns, e.g. `taskType[equals]:AUTOMATIC_SPEECH_RECOGNITION`.",
  })
  @ApiQuery({ name: 'sort', required: false, type: String, description: 'Comma-separated `field:asc|desc`. Defaults to `name:asc`.' })
  @ApiOkResponse({ type: PaginatedRegisteredModelViewResponse })
  @ApiResponse({
    status: 400,
    description: 'Malformed pagination or filter, or a filter, search field or sort naming a column this view does not return.',
  })
  @ApiResponse({ status: 403, description: 'The caller does not hold `read:AiModel`, or presented an API key.' })
  async registry(@Query() query: PaginatedQuery): Promise<PaginatedRegisteredModelViewResponse> {
    return this.aiModelService.listRegistry(query);
  }
}
