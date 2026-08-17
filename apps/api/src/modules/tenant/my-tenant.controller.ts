import {
  ITenantService,
  TenantResponse,
  TenantDtoMapper,
  PaginatedTenantConfigResponse,
  TenantConfigResponse,
  TenantConfigDtoMapper,
  IActiveUserContext,
  ITenantFrontendConfigService,
  LOCAL_RAW_CAPTURE_CAPABILITY_KEY,
  UpdateTenantConfigRequest,
} from '@arcaai/applications';
import { ValueType } from '@arcaai/domains';
import { Controller, Get, Patch, Body, Inject, BadRequestException, ParseArrayPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';

@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenant')
@Authorize()
export class MyTenantController {
  constructor(
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    @Inject(ITenantFrontendConfigService)
    private readonly tenantFrontendConfigService: ITenantFrontendConfigService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  /**
   * Returns the tenant entity associated with the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present — super-admins must use
   * the /admin/tenants endpoints to manage other tenants instead of relying on a
   * silent global fallback.
   */
  @Get('me')
  @ApiOperation({ summary: 'Get current tenant information' })
  @ApiResponse({ status: 200, description: 'Tenant information retrieved successfully', type: TenantResponse })
  @ApiResponse({ status: 400, description: 'Bad request - no tenant context' })
  async me(): Promise<TenantResponse> {
    const tenantId = this.resolveTenantId();
    const result = await this.tenantService.fetchById(tenantId);
    return TenantDtoMapper.ToResponse(result);
  }

  /**
   * Returns the configuration rows for the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present (no silent global
   * fallback for super-admins).
   */
  @Get('me/config')
  @ApiOperation({ summary: 'Get current tenant configuration' })
  @ApiResponse({ status: 200, description: 'Tenant configuration retrieved successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 400, description: 'Bad request - no tenant context' })
  async myConfig(): Promise<PaginatedTenantConfigResponse> {
    const tenantId = this.resolveTenantId();
    const result = await this.tenantService.fetchTenantConfigs({ tenantId, limit: 200, page: 1 });
    const response = TenantConfigDtoMapper.ToPaginatedResponse(result);

    // Surface the server-computed effective local raw-capture flag
    // (platform capability AND tenant toggle) as a synthetic, read-only config
    // row keyed `enable-local-raw-capture`. The SDK maps it into
    // `audio.captureRawAudio`; the user cannot override it (admin-owned in the
    // cascade). It is appended here so it scopes to GET /tenant/me/config only.
    const effective = await this.tenantFrontendConfigService.resolveEffectiveLocalRawCapture(tenantId);
    const rawCaptureRow = this.buildLocalRawCaptureRow(tenantId, effective);

    return new PaginatedTenantConfigResponse({
      page: response.page,
      limit: response.limit,
      count: response.count + 1,
      data: [...response.data, rawCaptureRow],
    });
  }

  /**
   * Updates configuration rows for the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present (no silent global
   * fallback for super-admins).
   */
  @Patch('me/config')
  @Authorize(['update', 'Tenant'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update current tenant configuration',
    description:
      "Updates one or more configuration values for the caller's tenant. " +
      'Optimistic concurrency is enforced: the `If-Match` ' +
      'header (RFC 7232) is REQUIRED, and the server runs a Compare-And-Set ' +
      "against the row's `_version`. When the header is present, its value " +
      'is applied as the `expectedVersion` for EVERY row in the request — ' +
      'the SDK should set `If-Match: "<min(versions)>"` (the most conservative ' +
      'choice) for bulk updates, OR omit per-row body fields and rely on the ' +
      'header alone for single-row updates. The body-field `expectedVersion` ' +
      'remains required by the DTO as the documented fallback for service-to-' +
      'service callers, but the header takes precedence when set.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`). ' +
      "The server CAS'es against this value; if `_version` has drifted, a `412 " +
      'Precondition Failed` is returned with the current version in the response body. ' +
      'If absent on this route, the response is `428 Precondition Required`.',
    required: true,
    example: '"7"',
  })
  @ApiResponse({ status: 200, description: 'Tenant configuration updated successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 400, description: 'Bad request — no tenant context, invalid body, or malformed If-Match.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateMyConfig(
    // The global ValidationPipe does NOT
    // validate top-level array bodies element-wise (NestJS treats the metatype
    // as `Array`, so class-validator never runs per item). ParseArrayPipe
    // re-applies the same `whitelist` + `forbidNonWhitelisted` posture to each
    // element so smuggled keys (e.g. key/locked/defaultValue) are rejected with
    // 400 at the HTTP boundary, not silently dropped by the service allowlist.
    @Body(new ParseArrayPipe({ items: UpdateTenantConfigRequest, whitelist: true, forbidNonWhitelisted: true }))
    configs: UpdateTenantConfigRequest[],
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PaginatedTenantConfigResponse> {
    const tenantId = this.resolveTenantId();
    // When the `If-Match` header is
    // present, it overrides each row's body-field `expectedVersion`. The
    // SDK is expected to set the header even for bulk updates (using the
    // minimum row version is the conservative choice); the body-field
    // path stays in service-to-service traffic. On a `@RequiresIfMatch()`
    // route, `expectedFromHeader` is guaranteed to be a number — the
    // 428 fired in the param decorator if it would have been undefined.
    const effectiveConfigs = expectedFromHeader !== undefined ? configs.map((c) => ({ ...c, expectedVersion: expectedFromHeader })) : configs;
    const result = await this.tenantService.updateTenantConfigs(tenantId, effectiveConfigs);
    return TenantConfigDtoMapper.ToPaginatedResponse(result);
  }

  private resolveTenantId(): string {
    const tenantId = this.clsService.get('tenantId');
    if (tenantId) return tenantId;

    throw new BadRequestException('Tenant context is required. Super-admins must use /admin/tenants endpoints to manage other tenants.');
  }

  /**
   * Builds the synthetic, read-only `enable-local-raw-capture` row
   * carrying the server-computed effective boolean. It is not backed by a
   * persisted GlobalSetting (the value is `platformCapability AND tenantToggle`),
   * so identity/audit fields are empty and `version` is 0; the SDK only reads
   * `key`, `namespace`, `value`, and `dataType`.
   */
  private buildLocalRawCaptureRow(tenantId: string, enabled: boolean): TenantConfigResponse {
    return {
      id: '',
      projectId: null,
      createdAt: '',
      updatedAt: '',
      resourceStatus: null,
      resourceStatusUpdatedAt: null,
      resourceStatusUpdatedBy: null,
      createdBy: null,
      updatedBy: null,
      name: 'Enable Local Raw Capture',
      description: 'Server-computed effective flag: platform capability AND tenant toggle. Read-only; cannot be overridden by user preferences.',
      key: LOCAL_RAW_CAPTURE_CAPABILITY_KEY,
      defaultValue: 'false',
      value: enabled ? 'true' : 'false',
      dataType: ValueType.Boolean,
      namespace: 'feature-flags',
      tenantId,
      tenantCode: '',
      version: 0,
    };
  }
}
