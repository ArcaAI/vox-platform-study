import {
  IPromptManagementService,
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptUsageAnalyticsResponse,
  DepartmentResponse,
  HttpMethod,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
// TASK-302 Stream D Phase E.3 — `@RequiresIfMatch()` + `@ExpectedVersion()`
// gate the OCC-enforced PATCH route below.
import { ApiEndpoint, Authorize, RequiresIfMatch, ExpectedVersion } from '../../decorators';
import { PaginatedPromptTemplateResponse, PromptUsageStatsResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-prompt-templates')
// TASK-319 F4 — prompt-template management is an admin capability; mounting it
// under the audited `/admin` prefix brings it in line with the other admin
// surfaces and the boot-time admin-route permission audit (F6). The existing
// `@Authorize(['read','PromptTemplate'])` + per-method tuples are unchanged.
@Controller('admin/prompt-templates')
@Authorize(['read', 'PromptTemplate'])
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
  @ApiQuery({ name: 'departmentId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled templates in results' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @Query() queryParams: { category?: string; departmentId?: string; search?: string; includeDisabled?: string; page?: number; limit?: number },
  ): Promise<PaginatedPromptTemplateResponse> {
    // TASK-328 A4 — pagination is pushed down to the repository
    // (`findPaginated` → `db.findMany` + `db.count`) instead of materializing
    // the full tenant result set and slicing it in memory.
    return this.promptService.listPromptTemplatesPaginated({
      category: queryParams.category,
      departmentId: queryParams.departmentId,
      search: queryParams.search,
      includeDisabled: queryParams.includeDisabled === 'true',
      page: Number(queryParams.page) || 1,
      limit: Number(queryParams.limit) || 50,
    });
  }

  // TASK-328 A4 — declared BEFORE the `:id` / `:id/usage` param routes so the
  // static `analytics/usage` path is not shadowed by `:id/usage`.
  @Get('analytics/usage')
  @ApiOperation({ summary: 'Usage analytics grouped by department / doctor / day (TASK-328 A4)' })
  @ApiQuery({ name: 'promptTemplateId', required: false, type: String, description: 'Narrow analytics to a single template' })
  @ApiResponse({ status: 200, description: 'Usage analytics aggregates', type: PromptUsageAnalyticsResponse })
  async getUsageAnalytics(@Query() queryParams: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse> {
    return this.promptService.getUsageAnalytics({ promptTemplateId: queryParams.promptTemplateId });
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
      'Updates one prompt template row. Optimistic concurrency is enforced ' +
      '(TASK-302 Stream D Phase E.3): the `If-Match` header (RFC 7232) is ' +
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
    // TASK-302 Stream D Phase E.3 — header takes precedence over body
    // when both are present. On a `@RequiresIfMatch()` route the param
    // decorator fired 428 if the header was missing.
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

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get usage statistics for a prompt template' })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 200, description: 'Usage statistics', type: PromptUsageStatsResponse })
  async getUsageStats(@Param('id') id: string): Promise<PromptUsageStatsResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = this.promptService as any;
    return svc.getUsageStats(id);
  }

  // ─── TASK-328 A4: prompt quality/score test run ──────────────────────

  @ApiEndpoint({
    returnedModel: PromptTestResultResponse,
    method: HttpMethod.POST,
    path: ':id/test',
    by: ['id'],
  })
  @Authorize(['update', 'PromptTemplate'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Run a prompt template against the SMR/text-generation service',
    description:
      'Generates an output + numeric score for the template and persists ' +
      '`lastTestScore/lastTestOutput/lastTestAt`. This is an optimistic-' +
      'concurrency write (parity with PATCH): the `If-Match` header is REQUIRED ' +
      'and folds over any body-supplied `expectedVersion`. Version drift → 412.',
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
  async testTemplate(
    @Param('id') id: string,
    @Body() request: TestPromptTemplateRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PromptTestResultResponse> {
    // TASK-328 A4 — header takes precedence over body when both are present
    // (mirrors `update`); on a `@RequiresIfMatch()` route the param decorator
    // already fired 428 if the header was missing.
    const effectiveRequest: TestPromptTemplateRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.promptService.testPromptTemplate(id, effectiveRequest);
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

    // TASK-302 Stream D Phase E.3 — `updatePromptTemplate` now requires
    // `expectedVersion`. This route is a server-driven rollback (no
    // user-supplied If-Match) so we read the template's current
    // `_version` and pass it. A concurrent edit between this read and
    // the CAS write surfaces as `412 Precondition Failed`, which is
    // the correct behavior — the operator should retry.
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
  @ApiOperation({ summary: 'Assign prompt templates to a department (TASK-294 DEF-C4)' })
  @ApiBody({ type: AssignDepartmentPromptRequest })
  @ApiResponse({ status: 200, description: 'Updated department prompt config', type: DepartmentResponse })
  @ApiResponse({ status: 403, description: 'Forbidden - caller lacks manage Department ability' })
  @ApiResponse({ status: 404, description: 'Department not found (or cross-tenant)' })
  async assignDepartment(@Body() request: AssignDepartmentPromptRequest): Promise<DepartmentResponse> {
    return this.promptService.assignToDepartment(request);
  }
}
