import { IWorkflowAssignmentService, UpsertWorkflowAssignmentRequest, WorkflowAssignmentResponse } from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';

/**
 * WorkflowAssignmentController — WHICH workflow definition governs a tenant or
 * department for a palette (TASK-733 half (a)), mounted at
 * `/admin/workflow-assignments` (global prefix -> `/api/v1/admin/...`).
 *
 * Authorization deliberately reuses `WorkflowDefinition`'s subject and service
 * scope: assigning a definition is a definition-GOVERNANCE act, not a new
 * resource class — a caller who may manage the tenant's definitions is exactly
 * the caller who may decide which department runs which one.
 *
 * Tenancy is service-enforced: the tenant-scope Prisma extension injects
 * `tenantId` from CLS, and the service asserts ownership on id-scoped
 * operations (cross-tenant id -> 404, never 403 — rule 04).
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-assignments')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:workflow-definition:manage')
@Controller('admin/workflow-assignments')
@CanManage('WorkflowDefinition')
export class WorkflowAssignmentController {
  constructor(
    @Inject(IWorkflowAssignmentService)
    private readonly workflowAssignmentService: IWorkflowAssignmentService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s workflow assignments for one palette' })
  @ApiQuery({ name: 'paletteKey', required: true, type: String })
  @ApiResponse({ status: 200, type: [WorkflowAssignmentResponse] })
  async fetchAll(@Query('paletteKey') paletteKey: string): Promise<WorkflowAssignmentResponse[]> {
    return this.workflowAssignmentService.listForPalette(paletteKey);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one workflow assignment' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: WorkflowAssignmentResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s assignment).' })
  async fetchById(@Param('id') id: string): Promise<WorkflowAssignmentResponse> {
    return this.workflowAssignmentService.getById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create the assignment for one (scope, scopeId, palette) tier',
    description:
      'Creates the tier’s assignment. Editing an EXISTING assignment goes through `PATCH` so the ' +
      'optimistic-concurrency contract applies; this route is the first write for a tier.',
  })
  @ApiResponse({ status: 201, type: WorkflowAssignmentResponse })
  @ApiResponse({ status: 400, description: 'Unknown palette, unsupported scope, or a slug with no PUBLISHED definition on that palette.' })
  @ApiResponse({ status: 404, description: 'The referenced department does not belong to the caller tenant.' })
  async create(@Body() request: UpsertWorkflowAssignmentRequest): Promise<WorkflowAssignmentResponse> {
    return this.workflowAssignmentService.upsert(request);
  }

  @Patch()
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Re-assign one tier',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and the ' +
      'server runs a Compare-And-Set against the row’s `_version`. When the header is present it ' +
      'overrides the body-field `expectedVersion`. Version drift is `412`; a missing header is `428`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiResponse({ status: 200, type: WorkflowAssignmentResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Body() request: UpsertWorkflowAssignmentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WorkflowAssignmentResponse> {
    // Header wins over the body field when both are present. On a
    // `@RequiresIfMatch()` route the param decorator already fired 428 when the
    // header was missing, so the body fallback only fires off-route.
    return this.workflowAssignmentService.upsert(request, expectedFromHeader ?? request.expectedVersion);
  }

  @Delete(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Remove one assignment — the tier reverts to inheriting',
    description: 'Soft-deletes the assignment row and appends a WORM change record with a null `afterSlug`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: WorkflowAssignmentResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s assignment).' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async remove(
    @Param('id') id: string,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('reason') reason?: string,
  ): Promise<WorkflowAssignmentResponse> {
    return this.workflowAssignmentService.remove(id, expectedFromHeader, reason ?? null);
  }
}
