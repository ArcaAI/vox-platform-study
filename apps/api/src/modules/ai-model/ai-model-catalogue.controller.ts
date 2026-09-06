import { AiModelService, ModelCatalogueQuery, ModelCatalogueResponse } from '@arcaai/applications';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@Controller('admin/ai-models')
export class AiModelCatalogueController {
  constructor(private readonly aiModelService: AiModelService) {}

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
}
