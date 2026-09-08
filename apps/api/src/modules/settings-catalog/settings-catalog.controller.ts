import {
  EffectiveSettingsService,
  HOPE_SETTINGS_REGISTRY,
  IActiveUserContext,
  isSuperAdmin,
  isTenantVisibleSetting,
  settingLockFor,
  visibleSettings,
  type SettingScope,
} from '@arcaai/applications';
import { BadRequestException, Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { EffectiveSettingResponse, SettingCatalogItemResponse, SettingCatalogResponse } from './dto/setting-catalog.response';
import { resolveSettingsReadTenantId } from './settings-scope';

/**
 * The capability/settings catalog surface.
 *
 * Serves the machine-readable inventory of admin-controllable settings from the
 * `HOPE_SETTINGS_REGISTRY` (tier / scope / sensitivity / category / editor). It
 * returns METADATA only — never a value — so it is safe for any admin to read.
 *
 * TASK-932 R-1 / D-5 — a TENANT admin sees only the keys its own tenant can hold
 * an opinion on (`isTenantVisibleSetting`: `maxScope` deeper than `system` AND
 * not `globalOnly`). Before this the filter checked `globalOnly` alone, so every
 * `maxScope: 'system'` descriptor still reached a tenant admin: the Bootstrap
 * floor, the Credentials inventory, Platform Operations, Service Runtime, the
 * STT/TTS runtime families — visible, un-writable rows describing the shape of
 * the platform's deployment. A super admin still sees everything; the inventory
 * IS the platform admin's map.
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
    const items: SettingCatalogItemResponse[] = visibleSettings(HOPE_SETTINGS_REGISTRY.list(), elevated).map((d) => {
      const lock = settingLockFor(d);
      return {
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
        // Derived, never listed — see `settingLockFor`. Emitted only when the
        // key IS locked, so `locked === undefined` and `locked === false` cannot
        // drift apart in a client's truthiness check.
        ...(lock ? { locked: true, lockLabel: lock.label, lockReason: lock.reason } : {}),
      };
    });
    const categories = [...new Set(items.map((i) => i.category))].sort();
    return { items, categories };
  }

  @Get('effective')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'Resolve the effective value of one non-secret setting for a context (with cascade trace).',
    description:
      'A platform-only key answers 404 for a tenant administrator — the catalog does not list it, and this route must not act as a directory for it. ' +
      'A platform admin with no working tenant and no `?tenantId` resolves the SYSTEM (platform) tier rather than being refused.',
  })
  @ApiQuery({ name: 'key', required: true, description: 'Registry key, e.g. harness.loop.emergencyStop.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiQuery({ name: 'departmentId', required: false })
  @ApiQuery({ name: 'doctorId', required: false })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['system', 'tenant'],
    description: 'Which tier to resolve against. `system` resolves the platform row with no tenant required; omitted keeps the legacy behaviour.',
  })
  @ApiResponse({ status: 200, type: EffectiveSettingResponse })
  @ApiResponse({ status: 400, description: 'Missing `key`, or `scope=tenant` with no tenant in context.' })
  @ApiResponse({ status: 404, description: 'Unknown key, or a platform-only key read by a tenant administrator.' })
  async getEffective(
    @Query('key') key: string,
    @Query('tenantId') tenantId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('doctorId') doctorId?: string,
    @Query('scope') scope?: SettingScope,
  ): Promise<EffectiveSettingResponse> {
    if (!key) {
      throw new BadRequestException('Query param `key` is required.');
    }
    this.assertVisible(key);
    const resolvedTenant = resolveSettingsReadTenantId(this.cls.get('user'), this.cls.get('tenantId'), {
      ...(scope ? { scope } : {}),
      ...(tenantId ? { queryTenantId: tenantId } : {}),
    });
    return this.effective.resolveEffective(key, {
      tenantId: resolvedTenant,
      departmentId: departmentId ?? null,
      doctorId: doctorId ?? null,
    });
  }

  /**
   * 404 for a key this caller may not address — including an UNKNOWN key, so the
   * two are indistinguishable.
   *
   * A filtered catalog that still answers per-key reads is a directory: an admin
   * who can enumerate the registry from the source tree would learn each
   * platform key's existence, value and cascade trace one request at a time. So
   * the answer is the same 404 the key-addressed registry route already gave for
   * `globalOnly`, extended to the rest of the platform surface.
   *
   * This is EXISTENCE HIDING for a configuration surface, not the cross-tenant
   * 404: a caller refused a key it CAN see, at a scope it may not write, still
   * gets the write lane's 403.
   */
  private assertVisible(key: string): void {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    if (!descriptor) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }
    if (!isSuperAdmin(this.cls.get('user')) && !isTenantVisibleSetting(descriptor)) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }
  }
}
