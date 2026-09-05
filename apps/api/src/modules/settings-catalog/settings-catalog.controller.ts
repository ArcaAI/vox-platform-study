import { EffectiveSettingsService, HOPE_SETTINGS_REGISTRY, IActiveUserContext, isSuperAdmin } from '@arcaai/applications';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { EffectiveSettingResponse, SettingCatalogItemResponse, SettingCatalogResponse } from './dto/setting-catalog.response';

/**
 * The capability/settings catalog surface.
 *
 * Serves the machine-readable inventory of admin-controllable settings from the
 * `HOPE_SETTINGS_REGISTRY` (tier / scope / sensitivity / category / editor). It
 * returns METADATA only — never a value — so it is safe for any admin to read.
 * A tenant admin does not see SUPER_ADMIN-only entries (they cannot edit them);
 * a super-admin sees everything.
 *
 * Route note: mounted at `admin/settings/catalog`. `SettingsCatalogModule` is
 * registered BEFORE `GlobalSettingModule` in `app.module` so this static route
 * wins over the global-setting `admin/settings/:id` param route.
 */
@ApiTags('admin-settings-catalog')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:settings:manage')
@Controller('admin/settings')
export class SettingsCatalogController {
  constructor(
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly effective: EffectiveSettingsService,
  ) {}

  @Get('catalog')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'List the capability/settings catalog (RBAC-filtered metadata).' })
  @ApiResponse({ status: 200, type: SettingCatalogResponse })
  getCatalog(): SettingCatalogResponse {
    const elevated = isSuperAdmin(this.cls.get('user'));
    const items: SettingCatalogItemResponse[] = HOPE_SETTINGS_REGISTRY.list()
      .filter((d) => elevated || !d.globalOnly)
      .map((d) => ({
        key: d.key,
        tier: d.tier,
        dataType: d.dataType,
        sensitivity: d.sensitivity,
        maxScope: d.maxScope,
        editableBy: d.editableBy,
        category: d.category,
        globalOnly: d.globalOnly,
        label: d.label,
        description: d.description,
        // the governance half. The console builds its
        // explain-before-you-click affordances from these; without them
        // `floorDirection` was only discoverable as a 403.
        killSwitch: d.killSwitch,
        failMode: d.failMode,
        floorDirection: d.floorDirection,
        // `default` is withheld for SECRET-sensitivity descriptors. The rest of
        // this catalog is metadata, but a secret's default is the one field that
        // could carry material; the effective-read surface already refuses
        // secrets outright, and this keeps the two surfaces consistent.
        default: d.sensitivity === 'secret' ? undefined : d.default,
        consumedBy: d.consumedBy,
        targetTier: d.targetTier,
      }));
    const categories = [...new Set(items.map((i) => i.category))].sort();
    return { items, categories };
  }

  @Get('effective')
  @CanRead('GlobalSetting')
  @ApiOperation({ summary: 'Resolve the effective value of one non-secret setting for a context (with cascade trace).' })
  @ApiQuery({ name: 'key', required: true, description: 'Registry key, e.g. harness.loop.emergencyStop.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiQuery({ name: 'departmentId', required: false })
  @ApiQuery({ name: 'doctorId', required: false })
  @ApiResponse({ status: 200, type: EffectiveSettingResponse })
  async getEffective(
    @Query('key') key: string,
    @Query('tenantId') tenantId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('doctorId') doctorId?: string,
  ): Promise<EffectiveSettingResponse> {
    if (!key) {
      throw new BadRequestException('Query param `key` is required.');
    }
    const resolvedTenant = resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), tenantId);
    return this.effective.resolveEffective(key, {
      tenantId: resolvedTenant,
      departmentId: departmentId ?? null,
      doctorId: doctorId ?? null,
    });
  }
}
