import {
  IDepartmentAgentService,
  DepartmentAgentResponse,
  DepartmentAgentVersionResponse,
  PaginatedDepartmentAgentResponse,
  CreateDepartmentAgentRequest,
  UpdateDepartmentAgentRequest,
  PinDepartmentAgentRequest,
  CloneDepartmentAgentRequest,
  PaginatedQuery,
  HttpMethod,
} from '@arcaai/applications';
import { Controller, Body, Param, Query, Post, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
// `@RequiresIfMatch()` + `@ExpectedVersion()` gate the OCC-enforced PATCH route.
import { ApiEndpoint, CanManage, RequiresIfMatch, ExpectedVersion } from '../../decorators';

@ApiBearerAuth()
@ApiTags('admin-department-agents')
@Controller('admin/department-agents')
// M-12: DepartmentAgent is a DEDICATED CASL subject (not HarnessPolicy reuse).
@CanManage('DepartmentAgent')
export class DepartmentAgentController {
  constructor(
    @Inject(IDepartmentAgentService)
    private readonly service: IDepartmentAgentService,
  ) {}

  @ApiEndpoint({ returnedModel: PaginatedDepartmentAgentResponse })
  @ApiQuery({ name: 'departmentId', required: false, type: String, description: 'Filter agents by department' })
  async list(@Query() query: PaginatedQuery, @Query('departmentId') departmentId?: string): Promise<PaginatedDepartmentAgentResponse> {
    return this.service.list(query, departmentId);
  }

  @ApiEndpoint({ returnedModel: DepartmentAgentResponse, path: ':id', by: ['id'] })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async getById(@Param('id') id: string): Promise<DepartmentAgentResponse> {
    return this.service.getById(id);
  }

  // TASK-672 — the immutable loop-config version history TASK-659 writes.
  // Plain `@Get`, not `@ApiEndpoint`: it returns a bare array, not one
  // resource-shaped body — mirrors `ConsultationContextSchemaAdminController`'s
  // `:id/versions` route.
  @Get(':id/versions')
  @ApiOperation({
    summary: 'List the immutable loop-configuration versions of an agent, newest first',
    description: 'Versions are never edited or deleted — a correction is a new version.',
  })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 200, type: [DepartmentAgentVersionResponse] })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async listVersions(@Param('id') id: string): Promise<DepartmentAgentVersionResponse[]> {
    return this.service.listVersions(id);
  }

  @ApiEndpoint({ returnedModel: DepartmentAgentResponse, method: HttpMethod.POST })
  @ApiResponse({ status: 400, description: 'Bad request — invalid binding, duplicate slug, or disallowed override key' })
  async create(@Body() request: CreateDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    return this.service.create(request);
  }

  @ApiEndpoint({ returnedModel: DepartmentAgentResponse, method: HttpMethod.PATCH, path: ':id', by: ['id'] })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update department agent',
    description:
      'Updates one agent row. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is ' +
      "REQUIRED, and the server runs a Compare-And-Set against the row's `_version`. On version drift the " +
      'response is `412 Precondition Failed`; missing header is `428 Precondition Required`.',
  })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the version the client read.', required: true, example: '"1"' })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 403, description: 'Locked template copy — clone to customize' })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateDepartmentAgentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DepartmentAgentResponse> {
    const effectiveRequest: UpdateDepartmentAgentRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.service.update(id, effectiveRequest);
  }

  @ApiEndpoint({ returnedModel: DepartmentAgentResponse, method: HttpMethod.DELETE, path: ':id', by: ['id'] })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 403, description: 'Locked template copy — clone to customize' })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async delete(@Param('id') id: string): Promise<DepartmentAgentResponse> {
    return this.service.deleteById(id);
  }

  // Scoped flag flip (atomic default within a department) — NOT If-Match gated.
  @Post(':id/set-default')
  @ApiOperation({ summary: 'Mark this agent as the department default (atomic flip)' })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async setDefault(@Param('id') id: string): Promise<DepartmentAgentResponse> {
    return this.service.setDefault(id);
  }

  // Pin/unpin the movable pointer to a PromptVersion — content-affecting but not
  // If-Match gated; validated server-side (existing + APPROVED-snapshot).
  @Post(':id/pin')
  @ApiOperation({ summary: 'Pin the agent to a PromptVersion number, or null to track latest APPROVED' })
  @ApiParam({ name: 'id', description: 'Department agent id', type: String })
  @ApiResponse({ status: 400, description: 'Version does not exist or is not an APPROVED snapshot' })
  @ApiResponse({ status: 403, description: 'Locked template copy — clone to customize' })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async pin(@Param('id') id: string, @Body() request: PinDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    return this.service.pin(id, request.versionNumber);
  }

  // Clone-to-customize (TASK-548): deep-copies the bound template into an
  // editable DRAFT tenant template and produces a NEW unlocked agent. This is
  // the sanctioned way to customize a LOCKED template copy — the console's
  // "clone to customize" (TASK-547) calls it. A NEW row, so no If-Match.
  @Post(':id/clone')
  @ApiOperation({
    summary: 'Clone an agent into a new editable copy (clone to customize)',
    description:
      'Deep-copies the bound PromptTemplate into an editable DRAFT tenant template and creates a new, ' +
      'UNLOCKED agent bound to it (carrying lineage). The source row is left untouched.',
  })
  @ApiParam({ name: 'id', description: 'Source department agent id', type: String })
  @ApiResponse({ status: 400, description: 'Duplicate slug within the department' })
  @ApiResponse({ status: 404, description: 'Department agent not found' })
  async clone(@Param('id') id: string, @Body() request: CloneDepartmentAgentRequest): Promise<DepartmentAgentResponse> {
    return this.service.clone(id, request);
  }
}
