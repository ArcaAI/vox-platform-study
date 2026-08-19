import {
  CreateWorkflowDefinitionRequest,
  IWorkflowDefinitionService,
  PaginatedQuery,
  PaginatedWorkflowDefinitionResponse,
  PublishWorkflowDefinitionRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * WorkflowDefinitionController — admin CRUD + compile/validate/publish for the
 * agentic-workflow-platform substrate (TASK-734), mounted at `/admin/workflow-definitions`
 * (global prefix -> `/api/v1/admin/workflow-definitions`). Mirrors
 * `WorkflowTestFixtureController` (mapper-in-service, If-Match OCC fold on PATCH).
 *
 * Tenancy is service-enforced: the tenant-scope Prisma extension injects `tenantId` from CLS
 * on every read/write of this model (rule 02), and the service additionally asserts tenant
 * ownership on id-scoped operations (cross-tenant id -> 404, never 403 — rule 04).
 *
 * `POST :id/validate` and `POST :id/publish` are NOT versioned PATCH routes — validate is
 * idempotent re-computation (not a CAS: it can run any number of times) and publish is
 * deliberately not a CAS either (`WorkflowDefinitionService.publish`'s doc comment — mirrors
 * `ConsultationContextSchemaService.publish`), so neither carries `@RequiresIfMatch()`.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-definitions')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:workflow-definition:manage')
@Controller('admin/workflow-definitions')
@CanManage('WorkflowDefinition')
export class WorkflowDefinitionController {
  constructor(
    @Inject(IWorkflowDefinitionService)
    private readonly workflowDefinitionService: IWorkflowDefinitionService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new DRAFT workflow definition version for the caller tenant' })
  @ApiResponse({ status: 201, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input, or the graph fails shape/engine validation.' })
  @ApiResponse({ status: 409, description: 'maxWorkflowDefinitions quota exceeded.' })
  async create(@Body() request: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.create(request);
  }

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s workflow definition versions' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWorkflowDefinitionResponse })
  async fetchAll(@Query() query: PaginatedQuery): Promise<PaginatedWorkflowDefinitionResponse> {
    return this.workflowDefinitionService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one workflow definition version' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.getById(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'List every version row in this definition’s (tenantId, slug) lineage, most recent first' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: [WorkflowDefinitionResponse] })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async fetchVersions(@Param('id') id: string): Promise<WorkflowDefinitionResponse[]> {
    return this.workflowDefinitionService.listVersions(id);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a DRAFT workflow definition version (If-Match OCC)',
    description:
      'Sparse patch. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and ' +
      "CAS'es against the row `_version`; drift → 412, missing header → 428. Rejected 400 if the row is " +
      'PUBLISHED/DEPRECATED (branch a new draft instead), or if a replaced `graph` fails shape/engine validation.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateWorkflowDefinitionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WorkflowDefinitionResponse> {
    const effectiveRequest: UpdateWorkflowDefinitionRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.workflowDefinitionService.update(id, effectiveRequest);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a workflow definition version' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.deleteById(id);
  }

  @Post(':id/validate')
  @ApiOperation({
    summary: 'Re-run shape + engine + DRAFT rule-catalogue validation and persist the report',
    description:
      'Advances DRAFT -> VALIDATED when the engine gate (shape + compile()) is clean. DRAFT rule-catalogue ' +
      'findings (TASK-716’s not-yet-clinically-reviewed rules) are recorded on the report but never block this.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Row is PUBLISHED/DEPRECATED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async validate(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.validate(id);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Compile the graph and publish this version',
    description:
      'Rejected 400 if the engine gate is not clean (a cycle, an unregistered node type, or malformed shape) — ' +
      'the sole publish-blocking predicate; DRAFT rule-catalogue findings never block publish. `activate` ' +
      '(default true) makes this the version the dispatcher resolves for new runs, demoting the slug’s previous ' +
      'active version.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Row is PUBLISHED/DEPRECATED, or the graph cannot be compiled.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.publish(id, request ?? {});
  }
}
