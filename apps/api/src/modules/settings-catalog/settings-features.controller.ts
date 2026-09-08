import { FeatureAvailabilityService, IActiveUserContext, isSuperAdmin } from '@arcaai/applications';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ForbidApiKey, NoOptimisticConcurrency, RequiredSvcScopes } from '../../decorators';
import {
  EffectiveFeaturesResponse,
  FeatureMatrixResponse,
  FeatureMatrixWriteBatchRequest,
  FeatureMatrixWriteResponse,
} from './dto/feature-availability.dto';

/**
 * Feature availability (TASK-932 R-4, R-8, R-10, R-14).
 *
 * Two surfaces with deliberately different audiences:
 *
 *  - `GET features/effective` — what the CALLER's tenant may use. Every admin,
 *    tenant admins included.
 *  - `GET/PUT features/matrix` — the platform admin's cross-tenant grid.
 *    Super administrators only, imperatively (see the AUTH-NOTEs).
 *
 * Mounted at `admin/settings` inside `SettingsCatalogModule`, which `app.module`
 * registers BEFORE `GlobalSettingModule` — so the static `features/...` segments
 * win over the global-setting `admin/settings/:id` param route, exactly as
 * `catalog` and `registry/:key` already do.
 */
@ApiTags('admin-settings-features')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:settings:manage')
@Controller('admin/settings')
export class SettingsFeaturesController {
  constructor(
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly features: FeatureAvailabilityService,
  ) {}

  /**
   * AUTH-NOTE: deliberately NOT gated to super administrators, although every
   * `Feature Availability` descriptor is `globalOnly` and is therefore filtered
   * out of the catalog for a tenant admin.
   *
   * This route serves VALUES, not the descriptor inventory, and the values are
   * facts about the CALLER'S OWN TENANT ("MCP is off for you"). The console
   * cannot decide whether to render a screen without them, so withholding them
   * would not protect anything — it would only make a tenant admin's navigation
   * wrong. There is no write path here and no cross-tenant read: an unscoped
   * platform admin resolves SYSTEM, an elevated caller with a working tenant
   * resolves that tenant, and everyone else is pinned to their own.
   */
  @Get('features/effective')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'Resolve every feature-availability gate for the calling context.',
    description:
      'Caller-scoped: a platform admin with no working tenant gets the SYSTEM (platform) values; with a working tenant, that tenant’s effective values; a tenant admin, its own. ' +
      '`sourceScope` reports which tier answered, so a console can say a value is INHERITED rather than chosen. Values only — never the descriptor inventory, and never a write path.',
  })
  @ApiResponse({ status: 200, type: EffectiveFeaturesResponse })
  @ApiResponse({ status: 403, description: 'The caller lacks `read:GlobalSetting`.' })
  getEffectiveFeatures(): EffectiveFeaturesResponse {
    const user = this.cls.get('user');
    const tenantId = this.cls.get('tenantId') ?? user?.tenantId ?? null;
    // An elevated caller with NO working tenant asks about the platform tier,
    // not about a customer. `50000000-...` ("Global") is a customer tenant and
    // must never stand in for the platform here (rule 00).
    const resolved = isSuperAdmin(user) ? (tenantId ?? null) : tenantId;
    return { items: this.features.resolveEffectiveForTenant(resolved) };
  }

  /**
   * AUTH-NOTE: SUPER_ADMIN-only, enforced imperatively in
   * `FeatureAvailabilityService.assertPlatformMatrixAccess` (403). The class-level
   * `@CanRead('GlobalSetting')` cannot express it: there is no "super admin" CASL
   * subject, and a tenant admin legitimately holds `read`/`manage` on
   * `GlobalSetting` for its OWN rows — which is the whole point of the resource.
   *
   * A 403 (privilege), never the 404-over-403 cross-tenant posture: the matrix is
   * platform configuration, not a per-row existence question, so there is no id
   * space to protect and nothing to hide by answering 404. The gate is
   * row-INDEPENDENT, so it may run first — unlike the split gates in rule 05,
   * which must resolve existence before privilege because their answer varies by
   * row. Every caller who is not a platform administrator gets the same 403 here.
   */
  @Get('features/matrix')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'The cross-tenant feature matrix: the platform default beside every tenant’s override.',
    description:
      'SUPER_ADMIN only (403 otherwise). `cells[].value === null` means the tenant holds NO row and inherits the platform default; the `system` column is never null. ' +
      'A feature whose `maxScope` is `system` contributes no tenant cells at all — its consumer has no tenant in hand, so a per-tenant row could never be honoured, and the screen disables those columns rather than offering a checkbox the cascade would ignore. ' +
      'Every `version` is read FRESH from the row, never from the settings cache: two admins editing inside one 45s cache window would otherwise compare against the same stale number.',
  })
  @ApiResponse({ status: 200, type: FeatureMatrixResponse })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  async getFeatureMatrix(): Promise<FeatureMatrixResponse> {
    const matrix = await this.features.readMatrix();
    return {
      features: matrix.features.map((d) => ({
        key: d.key,
        ...(d.label === undefined ? {} : { label: d.label }),
        ...(d.description === undefined ? {} : { description: d.description }),
        default: d.default === true,
        maxScope: d.maxScope,
        ...(d.killSwitch === undefined ? {} : { killSwitch: d.killSwitch }),
        category: d.category,
      })),
      tenants: matrix.tenants,
      cells: matrix.cells,
    };
  }

  /**
   * AUTH-NOTE: SUPER_ADMIN-only, same imperative gate and same reasoning as
   * `getFeatureMatrix` above (403, row-independent, checked before any row is
   * resolved). Each cell is then applied through
   * `SettingsRegistryWriteService`, so every descriptor guard, the sys-event and
   * both invalidation publishes happen exactly as they do for a single-key PUT.
   */
  @Put('features/matrix')
  @CanManage('GlobalSetting')
  @NoOptimisticConcurrency(
    'per-CELL preconditions: each cell is a separate row under a separate tenant and carries its own `expectedVersion`, so one `If-Match` header could not address the batch',
  )
  @ApiOperation({
    summary: 'Apply a batch of feature-matrix edits.',
    description:
      'SUPER_ADMIN only (403 otherwise). `value: null` on a TENANT cell removes the override so it inherits again; on the `system` cell it rewrites the platform row to the descriptor default. ' +
      'The batch is ORDERED and PARTIAL, not all-or-nothing, and answers 200 either way: every cell that can be applied is, and the rest come back in `errors[]` with the status each would have produced on its own (412 drift, 400 refused, 403 privilege). ' +
      'Failing the whole save on one drifted cell would discard a screenful of unrelated valid edits and say nothing about which cell to re-read; and it could not be a real transaction anyway, since the write lane’s cache refresh and its two invalidation publishes are not transactional side effects.',
  })
  @ApiResponse({ status: 200, type: FeatureMatrixWriteResponse })
  @ApiResponse({ status: 400, description: 'Malformed batch (empty, over the 500-cell cap, or a non-boolean value).' })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  async putFeatureMatrix(@Body() request: FeatureMatrixWriteBatchRequest): Promise<FeatureMatrixWriteResponse> {
    return this.features.applyMatrix(
      request.cells.map((cell) => ({
        key: cell.key,
        tenantId: cell.tenantId,
        value: cell.value ?? null,
        ...(cell.expectedVersion === undefined ? {} : { expectedVersion: cell.expectedVersion }),
      })),
    );
  }
}
