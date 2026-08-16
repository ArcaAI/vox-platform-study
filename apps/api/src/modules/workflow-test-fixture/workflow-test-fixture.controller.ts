import {
  CreateWorkflowTestFixtureRequest,
  IWorkflowTestFixtureService,
  PaginatedQuery,
  PaginatedWorkflowTestFixtureResponse,
  UpdateWorkflowTestFixtureRequest,
  WorkflowTestFixtureResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, RequiresIfMatch, RequiredScopes } from '../../decorators';

/**
 * WorkflowTestFixtureController — admin CRUD for per-tenant saved synthetic
 * Workbench test inputs (TASK-721 §1 item 5), mounted at
 * `/admin/workflow-test-fixtures` (global prefix → `/api/v1/admin/workflow-test-fixtures`).
 * Mirrors `WebhookController` (mapper-in-service, If-Match OCC fold on PATCH).
 *
 * Tenancy is service-enforced: the tenant-scope Prisma extension injects
 * `tenantId` from CLS on every read/write of this model (rule 02), and the
 * service additionally asserts tenant ownership on id-scoped operations
 * (cross-tenant id -> 404, never 403 — rule 04).
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-test-fixtures')
@RequiredScopes('admin:workflow-test-fixture:manage')
@Controller('admin/workflow-test-fixtures')
@CanManage('WorkflowTestFixture')
export class WorkflowTestFixtureController {
  constructor(
    @Inject(IWorkflowTestFixtureService)
    private readonly workflowTestFixtureService: IWorkflowTestFixtureService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a synthetic Workbench test fixture for the caller tenant' })
  @ApiResponse({ status: 201, type: WorkflowTestFixtureResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input.' })
  async create(@Body() request: CreateWorkflowTestFixtureRequest): Promise<WorkflowTestFixtureResponse> {
    return this.workflowTestFixtureService.create(request);
  }

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s saved fixtures' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWorkflowTestFixtureResponse })
  async fetchAll(@Query() query: PaginatedQuery): Promise<PaginatedWorkflowTestFixtureResponse> {
    return this.workflowTestFixtureService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one fixture' })
  @ApiParam({ name: 'id', description: 'Fixture id' })
  @ApiResponse({ status: 200, type: WorkflowTestFixtureResponse })
  @ApiResponse({ status: 404, description: 'Fixture not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<WorkflowTestFixtureResponse> {
    return this.workflowTestFixtureService.findById(id);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a fixture (If-Match OCC)',
    description:
      'Sparse patch. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and ' +
      "CAS'es against the row `_version`; drift → 412, missing header → 428.",
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'Fixture id' })
  @ApiResponse({ status: 200, type: WorkflowTestFixtureResponse })
  @ApiResponse({ status: 404, description: 'Fixture not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateWorkflowTestFixtureRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WorkflowTestFixtureResponse> {
    const effectiveRequest: UpdateWorkflowTestFixtureRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.workflowTestFixtureService.update(id, effectiveRequest);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a fixture' })
  @ApiParam({ name: 'id', description: 'Fixture id' })
  @ApiResponse({ status: 200, type: WorkflowTestFixtureResponse })
  @ApiResponse({ status: 404, description: 'Fixture not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<WorkflowTestFixtureResponse> {
    return this.workflowTestFixtureService.deleteById(id);
  }
}
