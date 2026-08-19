import {
  IPromptManagementService,
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  ApprovePromptTemplateRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptTestAckResponse,
  FinalizePromptTestRequest,
  PromptUsageAnalyticsResponse,
  PromptVersionDiffResponse,
  PromptUsageRecordResponse,
  PaginatedPromptUsageRecordResponse,
  Paginated,
  DepartmentResponse,
  HttpMethod,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, RequiresIfMatch, ExpectedVersion, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { PaginatedPromptTemplateResponse, PromptUsageStatsResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-prompt-templates')
// Prompt-template management is an admin capability; mounting it under the
// audited `/admin` prefix brings it in line with the other admin surfaces and
// the boot-time admin-route permission audit.
//
// The class-level read surface is `manage:PromptTemplate` (not `read`). This
// keeps the admin GET routes that inherit the class decorator (list / getById
// / getVersions / getVersion / getUsageStats / analytics/usage) on the ADMIN
// plane: granting clinicians the `read:PromptTemplate` ability (for the
// end-user PromptTemplateController) must NOT also let them list every tenant
// template, peers' personal prompts, drafts, or usage analytics here. Admins
// already hold `manage` (no regression). Per-method
// `create/update/delete/test/activate` tuples below are unaffected — the
// guard reads metadata with `getAllAndOverride`, so a handler-level
// `@Authorize` wins over this class-level one.
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:prompt-template:manage')
@Controller('admin/prompt-templates')
@Authorize(['manage', 'PromptTemplate'])
export class PromptManagementController {
  constructor(
    @Inject(IPromptManagementService)
    private readonly promptService: IPromptManagementService,
  ) {}

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    method: HttpMethod.POST,
  })
  @Authorize(['create', 'PromptTemplate'])
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  async create(@Body() request: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    return this.promptService.createPromptTemplate(request);
  }

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    multi: true,
  })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED'], description: 'Filter by publication status' })
  @ApiQuery({ name: 'departmentId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled templates in results' })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL'],
    description: 'Filter by prompt scope',
  })
  @ApiQuery({ name: 'ownerUserId', required: false, type: String, description: 'Filter USER_PERSONAL prompts by owner user id' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @Query()
    queryParams: {
      category?: string;
      status?: string;
      departmentId?: string;
      search?: string;
      includeDisabled?: string;
      scope?: string;
      ownerUserId?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<PaginatedPromptTemplateResponse> {
    // Pagination is pushed down to the repository
    // (`findPaginated` → `db.findMany` + `db.count`) instead of materializing
    // the full tenant result set and slicing it in memory.
    return this.promptService.listPromptTemplatesPaginated({
      category: queryParams.category,
      status: queryParams.status,
      departmentId: queryParams.departmentId,
      search: queryParams.search,
      includeDisabled: queryParams.includeDisabled === 'true',
      scope: queryParams.scope,
      ownerUserId: queryParams.ownerUserId,
      page: Number(queryParams.page) || 1,
      limit: Number(queryParams.limit) || 50,
    });
  }

  // Declared BEFORE the `:id` / `:id/usage` param routes so the static
  // `analytics/usage` path is not shadowed by `:id/usage`.
  @Get('analytics/usage')
  @ApiOperation({ summary: 'Usage analytics grouped by department / doctor / day' })
  @ApiQuery({ name: 'promptTemplateId', required: false, type: String, description: 'Narrow analytics to a single template' })
  @ApiResponse({ status: 200, description: 'Usage analytics aggregates', type: PromptUsageAnalyticsResponse })
  async getUsageAnalytics(@Query() queryParams: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse> {
    return this.promptService.getUsageAnalytics({ promptTemplateId: queryParams.promptTemplateId });
  }

  // Tenant-scoped raw run rows for the tenant-detail "Agent Jobs" surface
  // (complements the aggregated analytics above). Static path, so it is also
  // declared BEFORE the `:id` param routes. Inherits the class-level
  // `manage PromptTemplate` posture (tenant-admin own tenant; super-admin
  // cross-tenant via X-Tenant-Id).
  @Get('usage-records')
  @ApiOperation({ summary: 'Paginated prompt run history (PromptUsageRecord rows), newest first' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (0-based)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Rows per page (default 20)' })
  @ApiQuery({ name: 'promptTemplateId', required: false, type: String, description: 'Narrow to a single template' })
  @ApiResponse({ status: 200, description: 'Paginated usage record rows', type: PaginatedPromptUsageRecordResponse })
  async listUsageRecords(
    @Query() queryParams: { page?: string; limit?: string; promptTemplateId?: string },
  ): Promise<Paginated<PromptUsageRecordResponse>> {
    return this.promptService.listUsageRecords({
      page: queryParams.page !== undefined ? Number(queryParams.page) || 0 : undefined,
      limit: queryParams.limit !== undefined ? Number(queryParams.limit) || 20 : undefined,
      promptTemplateId: queryParams.promptTemplateId,
    });
  }

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getById(@Param('id') id: string): Promise<PromptTemplateResponse> {
    const result = await this.promptService.getPromptTemplate(id);
    if (!result) throw new NotFoundException(`Prompt template ${id} not found`);
    return result;
  }

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @Authorize(['update', 'PromptTemplate'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update prompt template',
    description:
      'Updates one prompt template row. Optimistic concurrency is enforced: ' +
      'the `If-Match` header (RFC 7232) is ' +
      "REQUIRED, and the server runs a Compare-And-Set against the row's " +
      '`_version` column (distinct from `currentVersionNumber`, the PromptVersion ' +
      'history counter). When the header is present, its value overrides the ' +
      'body-field `expectedVersion`. On version drift the response is `412 ' +
      'Precondition Failed`; missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdatePromptTemplateRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PromptTemplateResponse> {
    // Header takes precedence over body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator fired 428 if the
    // header was missing.
    const effectiveRequest: UpdatePromptTemplateRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.promptService.updatePromptTemplate(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @Authorize(['delete', 'PromptTemplate'])
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async remove(@Param('id') id: string): Promise<PromptTemplateResponse> {
    return this.promptService.softDeletePromptTemplate(id);
  }

  @ApiEndpoint({
    returnedModel: PromptVersionResponse,
    path: ':id/versions',
    by: ['id'],
    multi: true,
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  async getVersions(@Param('id') id: string): Promise<PromptVersionResponse[]> {
    return this.promptService.getVersions(id);
  }

  @ApiEndpoint({
    returnedModel: PromptVersionResponse,
    path: ':id/versions/:versionNumber',
    by: ['id', 'versionNumber'],
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiParam({ name: 'versionNumber', description: 'Version number', type: Number })
  @ApiResponse({ status: 404, description: 'Version not found' })
  async getVersion(@Param('id') id: string, @Param('versionNumber', ParseIntPipe) versionNumber: number): Promise<PromptVersionResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = this.promptService as any;
    const result = await svc.getVersion(id, versionNumber);
    if (!result) throw new NotFoundException(`Version ${versionNumber} not found for template ${id}`);
    return result;
  }

  // Server-side field-level version diff. Inherits the class-level
  // `manage:PromptTemplate` (admin plane, same as the sibling
  // getVersions/getVersion reads). The static `diff` path segment keeps this
  // clear of `:id/versions/:versionNumber` and `.../activate`.
  @Get(':id/versions/:from/diff/:to')
  @ApiOperation({
    summary: 'Diff two versions of a prompt template (server-side)',
    description:
      'Returns a structured field-level diff (content + variables) plus a ' +
      'combined line diff between the "from" and "to" version numbers. ' +
      'Tenant-scoped: a cross-tenant/unknown template id is 404.',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiParam({ name: 'from', description: 'Base version number', type: Number })
  @ApiParam({ name: 'to', description: 'Target version number', type: Number })
  @ApiResponse({ status: 200, description: 'Structured version diff', type: PromptVersionDiffResponse })
  @ApiResponse({ status: 404, description: 'Template or version not found' })
  async diffVersions(
    @Param('id') id: string,
    @Param('from', ParseIntPipe) from: number,
    @Param('to', ParseIntPipe) to: number,
  ): Promise<PromptVersionDiffResponse> {
    return this.promptService.diffVersions(id, from, to);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get usage statistics for a prompt template' })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 200, description: 'Usage statistics', type: PromptUsageStatsResponse })
  async getUsageStats(@Param('id') id: string): Promise<PromptUsageStatsResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = this.promptService as any;
    return svc.getUsageStats(id);
  }

  // ─── Prompt quality/score test run (BUG-018: two calls) ────────

  @ApiEndpoint({
    returnedModel: PromptTestAckResponse,
    method: HttpMethod.POST,
    path: ':id/test',
    by: ['id'],
  })
  @Authorize(['update', 'PromptTemplate'])
  @ApiOperation({
    summary: 'Submit a prompt-template test run (returns immediately)',
    description:
      'Assembles the prompt, resolves the `text.test` provider/model and submits a ' +
      'STREAMING generation job to SMR, returning an ack in well under a second. ' +
      'Open the returned `streamUrl` over SSE for tokens, then call ' +
      '`POST :id/test/finalize` with the `taskId` to score and persist. ' +
      '`dryRun: true` returns the assembled prompt and generates NOTHING. ' +
      'This route no longer writes, so it carries NO `If-Match` requirement.',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 400, description: 'No `text.test` model configured, or an invalid provider/model pair.' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async testTemplate(@Param('id') id: string, @Body() request: TestPromptTemplateRequest): Promise<PromptTestAckResponse> {
    return this.promptService.startPromptTemplateTest(id, request);
  }

  @ApiEndpoint({
    returnedModel: PromptTestResultResponse,
    method: HttpMethod.POST,
    path: ':id/test/finalize',
    by: ['id'],
  })
  @Authorize(['update', 'PromptTemplate'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Score and persist a finished prompt-template test run',
    description:
      'Fetches the finished generation from SMR SERVER-SIDE by `taskId` (the generated ' +
      'text is never accepted from the request body), scores it, and persists ' +
      '`lastTestScore/lastTestOutput/lastTestAt`. This is the optimistic-concurrency ' +
      'write of the test flow: the `If-Match` header is REQUIRED and folds over any ' +
      'body-supplied `expectedVersion`. Version drift → 412.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 400, description: 'The generation task has not reached a terminal completed state.' })
  @ApiResponse({ status: 404, description: 'Template or generation task not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async finalizeTestTemplate(
    @Param('id') id: string,
    @Body() request: FinalizePromptTestRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PromptTestResultResponse> {
    // Header takes precedence over body when both are present (mirrors
    // `update`); on a `@RequiresIfMatch()` route the param decorator
    // already fired 428 if the header was missing.
    const effectiveRequest: FinalizePromptTestRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.promptService.finalizePromptTemplateTest(id, effectiveRequest);
  }

  // ─── prompt governance approval ─────────────────
  //
  // AUTH-NOTE: this route carries NO handler-level permission
  // decorator ON PURPOSE. It inherits the class-level
  // `@Authorize(['manage','PromptTemplate'])` (so the deny-by-default boot audit
  // is satisfied), and the real approval gate is IMPERATIVE in the service — the
  // permission system has no "super admins only" subject to express the SYSTEM
  // branch. Reading only the decorator therefore understates the gate. See
  // `.claude/rules/05-nestjs-api.md` §"Imperative privilege checks".
  //
  // OD-3 split gate (in `PromptManagementService.approveTemplate`):
  // - SYSTEM/library template (tenantId = SYSTEM) → SUPER_ADMIN-only privilege
  //   (403; the shared library is globally visible, so existence is not hidden).
  // - Tenant-owned template → a caller holding `manage:PromptTemplate` for that
  //   tenant (or a super admin) may approve; cross-tenant ids stay 404 via
  //   `assertOwnedByTenant` (404-over-403).
  //
  // Flips the template to `status = APPROVED` — the gate `prompt-resolution`
  // requires for clinical flows — pins a `PromptVersion` snapshot, and writes a
  // WORM-style change row via the existing sys-event.
  //
  // Optimistic concurrency (parity with `update`/`testTemplate`): the `If-Match`
  // header is REQUIRED and folds over any body-supplied `expectedVersion`; the
  // `@RequiresIfMatch()` param decorator fires 428 when it is missing, and a
  // version drift surfaces as 412 from the service CAS write.
  @Post(':id/approve')
  @HttpCode(200)
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Approve a prompt template for clinical use',
    description:
      'Sets `status = APPROVED` (required by prompt resolution for clinical ' +
      'flows), pins a PromptVersion snapshot, and records a WORM-style audit ' +
      'change row. OD-3 split gate: SYSTEM/library templates are SUPER_ADMIN-' +
      'only; tenant-owned templates require `manage:PromptTemplate` for that ' +
      'tenant — 403 otherwise. Optimistic ' +
      'concurrency: `If-Match` REQUIRED (folds over body `expectedVersion`); ' +
      'missing header → 428, version drift → 412. Idempotent: approving an ' +
      'already-APPROVED template returns the current row.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 200, description: 'Approved (or already-approved) template', type: PromptTemplateResponse })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — SYSTEM/library approval is SUPER_ADMIN-only; tenant templates require manage:PromptTemplate.',
  })
  @ApiResponse({ status: 404, description: 'Template not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async approve(
    @Param('id') id: string,
    @Body() request: ApprovePromptTemplateRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PromptTemplateResponse> {
    // Header takes precedence over body when both are present (mirrors
    // `update`/`testTemplate`); on this `@RequiresIfMatch()` route the param
    // decorator already fired 428 if the header was missing.
    const effectiveRequest: ApprovePromptTemplateRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.promptService.approveTemplate(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: PromptTemplateResponse,
    method: HttpMethod.POST,
    path: ':id/versions/:versionNumber/activate',
    by: ['id', 'versionNumber'],
  })
  @Authorize(['update', 'PromptTemplate'])
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiParam({ name: 'versionNumber', description: 'Version number to activate', type: Number })
  @ApiResponse({ status: 404, description: 'Version not found' })
  async activateVersion(@Param('id') id: string, @Param('versionNumber', ParseIntPipe) versionNumber: number): Promise<PromptTemplateResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = this.promptService as any;
    const version = await svc.getVersion(id, versionNumber);
    if (!version) throw new NotFoundException(`Version ${versionNumber} not found for template ${id}`);

    // `updatePromptTemplate` requires `expectedVersion`. This route is a
    // server-driven rollback (no user-supplied If-Match) so we read the
    // template's current `_version` and pass it. A concurrent edit between
    // this read and the CAS write surfaces as `412 Precondition Failed`,
    // which is the correct behavior — the operator should retry.
    const currentTemplate = await this.promptService.getPromptTemplate(id);
    if (!currentTemplate) throw new NotFoundException(`Prompt template ${id} not found`);

    return this.promptService.updatePromptTemplate(id, {
      content: version.content,
      variables: version.variables,
      changeReason: `Activated version ${versionNumber}`,
      expectedVersion: currentTemplate.version,
    } as UpdatePromptTemplateRequest);
  }

  @Post('assign-department')
  @HttpCode(200)
  @Authorize(['manage', 'Department'])
  @ApiOperation({ summary: 'Assign prompt templates to a department' })
  @ApiBody({ type: AssignDepartmentPromptRequest })
  @ApiResponse({ status: 200, description: 'Updated department prompt config', type: DepartmentResponse })
  @ApiResponse({ status: 403, description: 'Forbidden - caller lacks manage Department ability' })
  @ApiResponse({ status: 404, description: 'Department not found (or cross-tenant)' })
  async assignDepartment(@Body() request: AssignDepartmentPromptRequest): Promise<DepartmentResponse> {
    return this.promptService.assignToDepartment(request);
  }
}
