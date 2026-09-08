import {
  EffectiveSettingsService,
  HOPE_SETTINGS_REGISTRY,
  IActiveUserContext,
  type SettingDescriptor,
  type SettingScope,
  SettingsRegistryWriteService,
  isSuperAdmin,
  isTenantVisibleSetting,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, NotFoundException, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, ForbidApiKey, NoOptimisticConcurrency, RequiredSvcScopes } from '../../decorators';
import { EffectiveSettingResponse } from './dto/setting-catalog.response';
import { ResetRegistrySettingResponse, WriteRegistrySettingRequest, WriteRegistrySettingResponse } from './dto/registry-setting.dto';
import { resolveSettingsReadTenantId } from './settings-scope';

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
@ApiTags('admin-settings-registry')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:settings:manage')
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
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['system', 'tenant'],
    description:
      'Which ROW the returned `version`/ETag refers to — the scope the caller intends to PUT at. Defaults to `system` (the platform row). A tenant admin editing its own override must pass `tenant`, or it will echo the platform row’s version as `If-Match` and get a 412.',
  })
  @ApiResponse({ status: 200, type: EffectiveSettingResponse })
  @ApiResponse({ status: 404, description: 'Unknown registry key.' })
  async getSetting(
    @Param('key') key: string,
    @Query('tenantId') tenantId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('doctorId') doctorId?: string,
    @Query('scope') scope?: SettingScope,
  ): Promise<EffectiveSettingResponse> {
    this.descriptorOr404(key);

    // TASK-932 R-6 — the READ resolves against the row the caller intends to
    // WRITE. `scope=system` is the platform row on the reserved SYSTEM tenant,
    // so it needs neither `?tenantId` nor a working tenant; asking for one was
    // what made a platform admin unable to open — and therefore to save — any
    // setting from an unscoped session. See `settings-scope.ts`.
    const resolvedTenant = resolveSettingsReadTenantId(this.cls.get('user'), this.cls.get('tenantId'), {
      scope: scope ?? 'system',
      ...(tenantId ? { queryTenantId: tenantId } : {}),
    });
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
    //
    // `scope` selects WHICH row that version comes from. With
    // `maxScope: 'tenant'` keys there are now two rows per key (the platform
    // one and the caller tenant's override), and preconditioning a tenant write
    // on the platform row's version would 412 forever.
    const version = await this.writeService.getBackingRowVersion(key, scope ?? 'system');
    return { ...effective, version };
  }

  @Put('registry/:key')
  @CanManage('GlobalSetting')
  @NoOptimisticConcurrency(
    'create-or-update: `@RequiresIfMatch()` would 428 the FIRST write (no row ⇒ no ETag ⇒ nothing to echo); the service applies the precondition only when a row exists',
  )
  @ApiOperation({
    summary: 'Write one registry setting through the single descriptor-driven enforcement point.',
    description:
      'Enforcement order: unknown key → 400; secret sensitivity → 400; `globalOnly` without super admin → 403; ' +
      'scope deeper than the descriptor `maxScope` → 400; non-`global-kv` tier → 400 (those keys keep their ' +
      'dedicated services); value type mismatch against `dataType` → 400. On success the backing KV row is ' +
      'upserted under the reserved `registry` namespace, a sys-event is broadcast, and the AppSettings cache ' +
      'the consumers read is refreshed.',
  })
  @ApiParam({ name: 'key', description: 'Registry key, e.g. `agentic.context.liveDelta.maxChars`.' })
  @ApiResponse({ status: 200, type: WriteRegistrySettingResponse })
  @ApiResponse({ status: 400, description: 'Unknown key, secret key, unwritable tier, bad scope, or value type mismatch.' })
  @ApiResponse({ status: 403, description: 'The setting is super-admin-only.' })
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
    // Existence FIRST, and the same 404 the GET gives: a key a tenant admin may
    // not see must not be discoverable by writing to it either. The write lane's
    // own `globalOnly` 403 stays as the backstop for a key that IS visible.
    this.descriptorOr404(key);
    return this.writeService.write(key, request.value, {
      ...(request.scope ? { scope: request.scope } : {}),
      // Header wins over body, matching the house precedence (department.controller).
      ...((expectedFromHeader ?? request.expectedVersion) !== undefined ? { expectedVersion: expectedFromHeader ?? request.expectedVersion } : {}),
    });
  }

  @Delete('registry/:key')
  @CanManage('GlobalSetting')
  @NoOptimisticConcurrency(
    'reset-to-inherited: the outcome (no row) does not depend on what the row contained, and the batch matrix save resets cells the caller never opened',
  )
  @ApiOperation({
    summary: 'Reset one TENANT override so the key resumes inheriting the platform default.',
    description:
      'Removes the working tenant row for `key`, after which the cascade resolves `SYSTEM` -> descriptor default again. ' +
      'Idempotent: a key with no override answers 200 with `removed: false` rather than 404, so a "reset every tenant" sweep does not fail on the tenants that never had one. ' +
      '`scope=system` is refused 400 -- the platform row is the top of the cascade, so there is nothing above it to inherit; write the descriptor default explicitly instead. ' +
      'A super administrator resets another tenant by selecting it as the working tenant, exactly as a write does.',
  })
  @ApiParam({ name: 'key', description: 'Registry key, e.g. `console.mlflow.enabled`.' })
  @ApiQuery({ name: 'scope', required: false, enum: ['tenant'], description: 'Defaults to `tenant`. `system` is refused.' })
  @ApiResponse({ status: 200, type: ResetRegistrySettingResponse })
  @ApiResponse({ status: 400, description: '`scope=system`, a locked tier, an unwritable tier, or a scope deeper than the descriptor `maxScope`.' })
  @ApiResponse({ status: 403, description: 'The setting is super-admin-only.' })
  @ApiResponse({ status: 404, description: 'Unknown key, or a platform-only key addressed by a tenant administrator.' })
  async resetSetting(@Param('key') key: string, @Query('scope') scope?: SettingScope): Promise<ResetRegistrySettingResponse> {
    this.descriptorOr404(key);
    return this.writeService.reset(key, { scope: scope ?? 'tenant' });
  }

  /**
   * The descriptor, or a 404 that cannot tell "unknown" from "not yours".
   *
   * TASK-932 R-1 / D-5 -- a tenant administrator addresses only the keys its own
   * tenant can hold an opinion on. Anything else answers 404 rather than 403, so
   * this lane cannot be walked as a directory of the platform's configuration by
   * someone who can read the key names out of the source tree. It is existence
   * hiding for a config surface, not the cross-tenant posture: a VISIBLE key
   * refused at a scope the caller may not write still returns the write lane's
   * 403.
   */
  private descriptorOr404(key: string): SettingDescriptor {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    // An unknown key on a path segment is a genuine "no such resource" -- 404,
    // unlike the 400 the write lane returns for an unknown key in a body.
    if (!descriptor) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }
    if (!isSuperAdmin(this.cls.get('user')) && !isTenantVisibleSetting(descriptor)) {
      throw new NotFoundException(`Unknown setting '${key}'.`);
    }
    return descriptor;
  }
}
