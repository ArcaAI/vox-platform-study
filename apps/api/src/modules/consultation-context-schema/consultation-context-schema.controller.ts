import {
  ConsultationContextSchemaBundleResponse,
  ConsultationContextSchemaResponse,
  ConsultationContextSchemaVersionResponse,
  ContextSchemaUsagesResponse,
  CreateConsultationContextSchemaRequest,
  IConsultationContextSchemaService,
  PinConsultationContextSchemaVersionRequest,
  PublishConsultationContextSchemaRequest,
  UpdateConsultationContextSchemaRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Authorize, CanManage, ExpectedVersion, RequiresIfMatch, RequiredScopes, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Admin CRUD + governance for tenant-declared consultation context
 * schemas, at `/admin/consultation-context-schemas`.
 *
 * `tenantId` is never a route, query or body parameter: every handler is
 * scoped by whatever `IConsultationContextSchemaService` reads off CLS, so a
 * caller can neither forge nor read another tenant's schema. Cross-tenant ids
 * answer **404, never 403** (the 404-over-403 posture) — that is enforced in
 * the service's `findOwnedOrThrow`, which runs before any other work on every
 * by-id path, including `publish`.
 *
 * The class-level `@CanManage('ConsultationContextSchema')` is the whole gate:
 * this resource carries NO imperative privilege check, so unlike
 * `TenantAllowedOriginController` there is nothing here that the decorator
 * understates. `tenant-full-access` grants the ability scoped to
 * `conditions.tenantId` (seed `01-policy.ts`), so a TENANT_ADMIN manages its
 * own tenant's schemas and SUPER_ADMIN reaches it via `manage:all`.
 */
@ApiBearerAuth()
@ApiTags('admin-consultation-context-schemas')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-context-schema:manage')
@Controller('admin/consultation-context-schemas')
@CanManage('ConsultationContextSchema')
export class ConsultationContextSchemaAdminController {
  constructor(
    @Inject(IConsultationContextSchemaService)
    private readonly service: IConsultationContextSchemaService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the caller tenant's consultation context schemas" })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaResponse, isArray: true })
  async list(): Promise<ConsultationContextSchemaResponse[]> {
    return this.service.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one context schema by id' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async getById(@Param('id') id: string): Promise<ConsultationContextSchemaResponse> {
    return this.service.getById(id);
  }

  @Get(':id/usages')
  @ApiOperation({
    summary: 'List the workflows and agents bound to a context schema, with a verdict per consumer',
    description:
      'Answers "what does changing this schema break?" BEFORE an admin publishes. Every workflow and agent bound ' +
      'to the schema is listed with its `binding` (`latest` = its trigger re-reads the tenant pin at dispatch; ' +
      '`pinned` = it keeps the version it was published with) and a `verdict` against `againstVersion`.\n\n' +
      'A follow-latest consumer always `accepts`. A PINNED one `refuses` when the target version declares a kind ' +
      "its frozen trigger does not, and each such kind is named in `problems`; `unknown` means the consumer's " +
      'compiled configuration could not be read, which is reported rather than silently treated as acceptance.\n\n' +
      'This is the same document `POST :id/publish` and `POST :id/pin` return as `impact`, and the same one a ' +
      'publish refused with `SCHEMA_IMPACT_UNACKNOWLEDGED` carries — a preview and the write that follows it can ' +
      'never disagree.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({
    name: 'againstVersion',
    required: false,
    type: Number,
    description: "The version to judge consumers against. Defaults to the schema's currently pinned version.",
  })
  @ApiResponse({ status: 200, type: ContextSchemaUsagesResponse })
  @ApiResponse({ status: 404, description: 'Schema not found (or owned by another tenant), or it has no such version.' })
  async usages(
    @Param('id') id: string,
    @Query('againstVersion', new ParseIntPipe({ optional: true })) againstVersion?: number,
  ): Promise<ContextSchemaUsagesResponse> {
    return this.service.usages(id, againstVersion);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'List the immutable published versions of a context schema, newest first',
    description: 'Versions are never edited or deleted — a correction is a new version.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaVersionResponse, isArray: true })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async listVersions(@Param('id') id: string): Promise<ConsultationContextSchemaVersionResponse[]> {
    return this.service.listVersions(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a DRAFT context schema',
    description: 'A schema is always born DRAFT with no pinned version — `POST :id/publish` is the only way to get one.',
  })
  @ApiResponse({ status: 201, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 400, description: 'Scope/departmentId mismatch.' })
  @ApiResponse({ status: 409, description: 'The slug is already taken for this tenant.' })
  async create(@Body() request: CreateConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse> {
    return this.service.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update schema metadata under optimistic concurrency',
    description:
      'Metadata only — the DECLARATION is never edited in place (`POST :id/publish` writes a new immutable version). ' +
      '`If-Match` (RFC 7232) is REQUIRED; when present it overrides the body-field `expectedVersion`. Version drift ' +
      'answers 412, a missing header 428.',
  })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the version the client read (e.g. `"1"`).', required: true })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateConsultationContextSchemaRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ConsultationContextSchemaResponse> {
    // Header takes precedence over the body when both are present — the house
    // precedence (`department.controller.ts#update`).
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.service.update(id, effective);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Validate a definition, publish it as a new immutable version, and pin it',
    description:
      'Each `kinds[].primitive` must be one of the five platform primitives; `fields` must stay inside the authorable ' +
      'JSON Schema subset (no `if`/`then`/`else`; `oneOf` only with an explicit discriminator). Re-publishing an ' +
      'IDENTICAL definition is a no-op: no version row, no pin move, and the discovery ETag does not change. A ' +
      'BREAKING change (removed/renamed kind or property, changed primitive/type, widened `required`) is refused ' +
      'with 400 listing every break unless `allowBreakingChange` is set.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 400, description: 'The definition is not publishable, or the change is breaking and unacknowledged.' })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse> {
    return this.service.publish(id, request);
  }

  @Post(':id/pin')
  @ApiOperation({
    summary: 'Move the pin to an already-published version',
    description: 'The rollback path: discovery and payload validation immediately serve the named version instead.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 404, description: 'Schema not found (or owned by another tenant), or it has no such version.' })
  async pin(@Param('id') id: string, @Body() request: PinConsultationContextSchemaVersionRequest): Promise<ConsultationContextSchemaResponse> {
    return this.service.pin(id, request);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a context schema',
    description: 'Published versions are NOT removed — a ContextItem stamped with one must resolve it forever.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async deleteById(@Param('id') id: string): Promise<ConsultationContextSchemaResponse> {
    return this.service.deleteById(id);
  }
}

/**
 * The CLIENT DISCOVERY surface (/D4), at
 * `/tenant/me/context-schema`.
 *
 * A deliberate SIBLING of `GET /tenant/me/config`, not an addition to it:
 * that endpoint returns a flat `{key,value,namespace}[]` of `GlobalSetting`
 * rows and a nested schema bundle does not fit its shape. Every other
 * structured tenant config in this repo (`tenant-stt-config`,
 * `tenant-tts-config`, `tenant-storage-config`, `tenant-allowed-origin`) has
 * its own controller; this follows that convention.
 *
 * Gated with a bare `@Authorize()` — any authenticated caller in the tenant,
 * the same posture as the sibling `/tenants/me/*` reads. A clinician's client
 * has to read this to build its workflow at session open, so requiring an
 * admin ability here would make the feature unreachable by its actual
 * consumer.
 */
/**
 * `tenants/me/*` resolves to the key's TENANT (the CLS `tenantId`
 * `UnifiedAuthGuard` sets from `apiKeyEntity.tenantId`), NOT to the key's bound
 * user the way `/users/me/*` does. Two different resolutions behind the same
 * `me` segment, so each says which one it is.
 */
const ME_IS_THE_KEY_TENANT = "Under API-key authentication this resolves to the key's **tenant**.";

@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenants/me/context-schema')
@Authorize()
// API-KEY-NOTE: policy A1. Schema DISCOVERY — without it an integrator
// cannot build a valid consultation-context payload, which makes the whole
// consultation surface unusable from a key. Resolves to the key's tenant.
@RequiredScopes('tenant:context-schema:read')
// SVC-NOTE (TASK-933 §3.2, owner decision 2026-09-09): the SAME argument for the MACHINE class,
// and it is the reason this scope is in the realtime-consultation family at all. A broker that
// writes case notes has to know the tenant's declared kinds first — that is what
// `@arcaai/vox-codegen --tenant` types — and without this it would have to be handed a human's
// token to generate them. `me` here is the ACCOUNT'S WORKING TENANT, bound at token exchange, so
// there is no cross-tenant surface: another tenant's schema is not addressable from this route.
@RequiredSvcScopes('svc:tenant:context-schema:read')
export class MyTenantContextSchemaController {
  constructor(
    @Inject(IConsultationContextSchemaService)
    private readonly service: IConsultationContextSchemaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Discover the caller tenant's pinned consultation context schema",
    description:
      'Returns the RESOLVED, PINNED declaration (DEPARTMENT-scoped default → TENANT-scoped default), never simply ' +
      'the latest published version. A tenant with no configured schema gets a 200 whose fields are null and whose ' +
      'ETag is `"none"` — deliberately NOT a 404, which a client cannot tell apart from a routing mistake.\n\n' +
      ME_IS_THE_KEY_TENANT,
  })
  @ApiQuery({
    name: 'departmentId',
    required: false,
    description: 'Prefer the DEPARTMENT-scoped default for this department, falling back to the tenant default.',
  })
  @ApiHeader({ name: 'ETag', description: 'Strong validator over the served representation.' })
  @ApiResponse({ status: 200, type: ConsultationContextSchemaBundleResponse })
  async getEffective(
    @Query('departmentId') departmentId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConsultationContextSchemaBundleResponse> {
    const bundle = await this.service.getEffectiveBundle(departmentId);

    // Set explicitly rather than leaving it to the global `ETagInterceptor`:
    // that interceptor derives the validator from a top-level integer
    // `version`, i.e. it is the OCC validator for a mutable ROW. This
    // response is not a row — it is a resolved representation assembled from
    // a schema plus an immutable version — so its validator has to be
    // computed from what is actually served. The service owns that
    // computation; the controller only forwards it.
    response.setHeader('ETag', bundle.etag);

    return bundle;
  }
}
