import {
  CreateDocumentTemplateRequest,
  DocumentTemplateBundleResponse,
  DocumentTemplateResponse,
  DocumentTemplateVersionResponse,
  IDocumentTemplateService,
  PinDocumentTemplateVersionRequest,
  PublishDocumentTemplateRequest,
  UpdateDocumentTemplateRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Authorize, CanManage, ExpectedVersion, RequiresIfMatch, RequiredScopes, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Admin CRUD + governance for the tenant's clinical-document SHAPE catalog
 * (TASK-810), at `/admin/document-templates`.
 *
 * A DOCUMENT TEMPLATE is the shape of a document a generation node produces:
 * which sections exist, in which order, what form each takes, and which may
 * legitimately be left empty. Publishing COMPILES that shape into a strict
 * `json_schema` the model is decoded against — the template IS the schema, not
 * a request the model may decline.
 *
 * `tenantId` is never a route, query or body parameter: every handler is scoped
 * by whatever `IDocumentTemplateService` reads off CLS, so a caller can neither
 * forge nor read another tenant's template. Cross-tenant ids answer **404,
 * never 403** — enforced in the service's `findOwnedOrThrow`, which runs before
 * any other work on every by-id path, including `publish`.
 *
 * The class-level `@CanManage('DocumentTemplate')` is the whole gate: this
 * resource carries NO imperative privilege check, so unlike
 * `TenantAllowedOriginController` there is nothing here the decorator
 * understates.
 */
@ApiBearerAuth()
@ApiTags('admin-document-templates')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:document-template:manage')
@Controller('admin/document-templates')
@CanManage('DocumentTemplate')
export class DocumentTemplateAdminController {
  constructor(
    @Inject(IDocumentTemplateService)
    private readonly service: IDocumentTemplateService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List the caller tenant's document templates",
    description:
      'Head rows only — each carries its lifecycle status and `pinnedVersionNumber`, never a shape. The shape ' +
      'and its compiled artifacts live on the immutable version rows (`GET :id/versions`).',
  })
  @ApiResponse({ status: 200, type: DocumentTemplateResponse, isArray: true })
  @ApiResponse({ status: 400, description: 'No tenant context on the request.' })
  async list(): Promise<DocumentTemplateResponse[]> {
    return this.service.list();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one document template by id',
    description: 'The mutable head row. Cross-tenant ids answer 404, never 403, so existence is not disclosed.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: DocumentTemplateResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async getById(@Param('id') id: string): Promise<DocumentTemplateResponse> {
    return this.service.getById(id);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'List the immutable published versions of a template, newest first',
    description:
      'Versions are never edited or deleted — a correction is a new version, and a database trigger refuses any ' +
      'UPDATE or DELETE on the version table (OD-13). Each entry carries the shape, the artifacts compiled from ' +
      'it, and `versionSkew`: whether a reader still pinned to that version would keep working against the ' +
      'template’s CURRENT pin.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: DocumentTemplateVersionResponse, isArray: true })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async listVersions(@Param('id') id: string): Promise<DocumentTemplateVersionResponse[]> {
    return this.service.listVersions(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a DRAFT document template',
    description: 'A template is always born DRAFT with no pinned version — `POST :id/publish` is the only way to get one.',
  })
  @ApiResponse({ status: 201, type: DocumentTemplateResponse })
  @ApiResponse({ status: 409, description: 'The slug is already taken for this tenant.' })
  async create(@Body() request: CreateDocumentTemplateRequest): Promise<DocumentTemplateResponse> {
    return this.service.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update template metadata under optimistic concurrency',
    description:
      'Metadata only — the SHAPE is never edited in place (`POST :id/publish` writes a new immutable version). ' +
      '`If-Match` (RFC 7232) is REQUIRED; when present it overrides the body-field `expectedVersion`. Version ' +
      'drift answers 412, a missing header 428.',
  })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the version the client read (e.g. `"1"`).', required: true })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: DocumentTemplateResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateDocumentTemplateRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DocumentTemplateResponse> {
    // Header takes precedence over the body when both are present — the house
    // precedence (`department.controller.ts#update`).
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.service.update(id, effective);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Validate a shape, compile it, publish both as a new immutable version, and pin it',
    description:
      'The shape is validated (every problem returned at once), then COMPILED into the artifacts frozen onto the ' +
      'version row: a strict `response_format` json_schema, a section checklist, and a per-section state ' +
      'machine. An OPTIONAL section compiles to a NULLABLE property, so a model can record that a section was ' +
      'not discussed instead of inventing content to fill the heading.\n\n' +
      'Re-publishing an IDENTICAL shape with the SAME compiler is a no-op: no version row, no pin move. A ' +
      'BREAKING change (a removed or renamed section, a changed `form`, a changed STRUCTURED `fields` contract, ' +
      'or a section newly made `required`) is refused with 400 listing every break unless `allowBreakingChange` ' +
      'is set.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: DocumentTemplateResponse })
  @ApiResponse({ status: 400, description: 'The shape is not publishable, or the change is breaking and unacknowledged.' })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishDocumentTemplateRequest): Promise<DocumentTemplateResponse> {
    return this.service.publish(id, request);
  }

  @Post(':id/pin')
  @ApiOperation({
    summary: 'Move the pin to an already-published version',
    description: 'The rollback path: generation immediately resolves the named version instead.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: DocumentTemplateResponse })
  @ApiResponse({ status: 404, description: 'Template not found (or owned by another tenant), or it has no such version.' })
  async pin(@Param('id') id: string, @Body() request: PinDocumentTemplateVersionRequest): Promise<DocumentTemplateResponse> {
    return this.service.pin(id, request);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a document template',
    description: 'Published versions are NOT removed — a document generated against one must resolve it forever.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: DocumentTemplateResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async deleteById(@Param('id') id: string): Promise<DocumentTemplateResponse> {
    return this.service.deleteById(id);
  }
}

/**
 * TASK-758 — `tenants/me/*` resolves to the key's TENANT (the CLS `tenantId`
 * `UnifiedAuthGuard` sets from `apiKeyEntity.tenantId`), NOT to the key's bound
 * user the way `/users/me/*` does.
 */
const ME_IS_THE_KEY_TENANT = "Under API-key authentication this resolves to the key's **tenant**.";

/**
 * The CLIENT DISCOVERY surface, at `/tenants/me/document-template`.
 *
 * A deliberate sibling of `/tenants/me/context-schema`: that endpoint answers
 * "what context may I submit", this one answers "what document will come back".
 * A client that renders a generated note needs the section list and their order
 * before the first token arrives, and hardcoding four SOAP headings on the
 * client is the same mistake this ticket removed from the server.
 *
 * Gated with a bare `@Authorize()` — any authenticated caller in the tenant,
 * the same posture as the sibling `/tenants/me/*` reads.
 */
@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenants/me/document-template')
@Authorize()
// API-KEY-NOTE: policy A1. Shape DISCOVERY — without it an integrator cannot
// render or map a generated document. Resolves to the key's tenant.
@RequiredScopes('tenant:document-template:read')
export class MyTenantDocumentTemplateController {
  constructor(
    @Inject(IDocumentTemplateService)
    private readonly service: IDocumentTemplateService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Discover the caller tenant's pinned document template",
    description:
      'Returns the RESOLVED, PINNED shape and its compiled artifacts, never simply the latest published version. ' +
      'A tenant with no configured template gets a 200 whose fields are null and whose ETag is `"none"` — ' +
      'deliberately NOT a 404, which a client cannot tell apart from a routing mistake.\n\n' +
      ME_IS_THE_KEY_TENANT,
  })
  @ApiQuery({ name: 'slug', required: false, description: 'Resolve this template by slug instead of the tenant default.' })
  @ApiHeader({ name: 'ETag', description: 'Strong validator over the served representation.' })
  @ApiResponse({ status: 200, type: DocumentTemplateBundleResponse })
  async getEffective(@Query('slug') slug: string | undefined, @Res({ passthrough: true }) response: Response): Promise<DocumentTemplateBundleResponse> {
    const bundle = await this.service.getEffectiveBundle(slug);

    // Set explicitly rather than leaving it to the global `ETagInterceptor`:
    // that interceptor derives the validator from a top-level integer `version`,
    // i.e. the OCC validator for a mutable ROW. This response is not a row — it
    // is a resolved representation assembled from a template plus an immutable
    // version — so its validator has to be computed from what is actually
    // served. The service owns that computation; the controller only forwards it.
    response.setHeader('ETag', bundle.etag);

    return bundle;
  }
}
