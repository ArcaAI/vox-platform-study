import {
  EffectiveSettingsService,
  HOPE_SETTINGS_REGISTRY,
  IActiveUserContext,
  SettingsRegistryWriteService,
  isSuperAdmin,
} from '@arcaai/applications';
import { Body, Controller, Get, NotFoundException, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { EffectiveSettingResponse } from './dto/setting-catalog.response';
import { WriteRegistrySettingRequest, WriteRegistrySettingResponse } from './dto/registry-setting.dto';

/**
 * The settings registry READ/WRITE lane.
 *
 * `GET/PUT /admin/settings/registry/:key`. Before this ticket there was NO
 * write route for any registry key anywhere in the gateway: descriptors
 * declared `globalOnly` / `editableBy` / `maxScope` and nothing enforced them.
 *
 * All enforcement lives in `SettingsRegistryWriteService` (the single
 * enforcement point) — this controller only routes. In particular the
 * `globalOnly` → 403 rule is descriptor-driven in the service, NOT a
 * class-level decorator, so the same route serves both tenant-editable and
 * global-only keys with the correct answer for each.
 *
 * Route note: mounted at `admin/settings` inside `SettingsCatalogModule`, which
 * `app.module` registers BEFORE `GlobalSettingModule` — so the static
 * `registry/...` segment wins over the global-setting `admin/settings/:id`
 * param route. The legacy `GlobalSettingController` row CRUD is untouched;
 * this lane writes under the reserved `registry` namespace so the two write
 * paths over the same table stay distinguishable until they are reconciled.
 */
@ApiTags('Admin: Settings Registry')
@ApiBearerAuth()
@Controller('admin/settings')
export class SettingsRegistryWriteController {
  constructor(
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly effective: EffectiveSettingsService,
    private readonly writeService: SettingsRegistryWriteService,
  ) {}

  @Get('registry/:key')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'Read one registry setting: its descriptor metadata plus the effective value and cascade trace.',
  })
  @ApiParam({ name: 'key', description: 'Registry key, e.g. `agentic.context.liveDelta.maxChars`.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform admins scope with this; tenant admins are pinned.' })
  @ApiQuery({ name: 'departmentId', required: false })
  @ApiQuery({ name: 'doctorId', required: false })
  @ApiResponse({ status: 200, type: EffectiveSettingResponse })
  @ApiResponse({ status: 404, description: 'Unknown registry key.' })
  async getSetting(
    @Param('key') key: string,
    @Query('tenantId') tenantId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('doctorId') doctorId?: string,
  ): Promise<EffectiveSettingResponse> {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    // An unknown key on a path segment is a genuine "no such resource" — 404,
    // unlike the 400 the write lane returns for an unknown key in a body.
    if (!descriptor) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }
    // A tenant admin may not read a global-only key's value through this lane;
    // it is already filtered out of the catalog listing for them.
    if (descriptor.globalOnly && !isSuperAdmin(this.cls.get('user'))) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }

    const resolvedTenant = resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), tenantId);
    const effective = await this.effective.resolveEffective(key, {
      tenantId: resolvedTenant,
      departmentId: departmentId ?? null,
      doctorId: doctorId ?? null,
    });
    // Carry the backing row's version so the `ETagInterceptor`
    // renders `ETag: "<version>"` and the client can round-trip it as `If-Match`
    // on the PUT. 0 when no row is stored yet (the value is a code default), and
    // the interceptor deliberately emits no ETag for a non-positive version —
    // which is correct: there is nothing to precondition a first write against.
    const version = await this.writeService.getBackingRowVersion(key);
    return { ...effective, version };
  }

  @Put('registry/:key')
  @CanManage('GlobalSetting')
  @ApiOperation({
    summary: 'Write one registry setting through the single descriptor-driven enforcement point.',
    description:
      'Enforcement order: unknown key → 400; secret sensitivity → 400; `globalOnly` without global admin → 403; ' +
      'scope deeper than the descriptor `maxScope` → 400; non-`global-kv` tier → 400 (those keys keep their ' +
      'dedicated services); value type mismatch against `dataType` → 400. On success the backing KV row is ' +
      'upserted under the reserved `registry` namespace, a sys-event is broadcast, and the AppSettings cache ' +
      'the consumers read is refreshed.',
  })
  @ApiParam({ name: 'key', description: 'Registry key, e.g. `agentic.context.liveDelta.maxChars`.' })
  @ApiResponse({ status: 200, type: WriteRegistrySettingResponse })
  @ApiResponse({ status: 400, description: 'Unknown key, secret key, unwritable tier, bad scope, or value type mismatch.' })
  @ApiResponse({ status: 403, description: 'The setting is global-admin-only.' })
  @ApiResponse({ status: 412, description: 'The stored value changed since the caller read it (version drift).' })
  @ApiResponse({ status: 428, description: 'A stored value exists and no `If-Match` was supplied.' })
  async putSetting(
    @Param('key') key: string,
    @Body() request: WriteRegistrySettingRequest,
    // RFC 7232 precondition. Deliberately NOT `@RequiresIfMatch()`:
    // that guard 428s unconditionally, which would make a FIRST write impossible
    // (no row ⇒ no ETag ⇒ nothing for the client to echo). The service applies
    // the precondition only when a row actually exists, so first writes succeed
    // and subsequent ones cannot blind-overwrite.
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WriteRegistrySettingResponse> {
    return this.writeService.write(key, request.value, {
      ...(request.scope ? { scope: request.scope } : {}),
      // Header wins over body, matching the house precedence (department.controller).
      ...((expectedFromHeader ?? request.expectedVersion) !== undefined ? { expectedVersion: expectedFromHeader ?? request.expectedVersion } : {}),
    });
  }
}
