import {
  AgentResponse,
  AgentTask,
  CreateAgentRequest,
  IAgentService,
  NewAgentVersionRequest,
  PublishAgentRequest,
  UpdateAgentRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';

/**
 * AgentAdminController — the Agent authoring lifecycle (TASK-863 §3.3), mounted at
 * `/admin/agents` (global prefix -> `/api/v1/admin/agents`). Mirrors
 * `WorkflowDefinitionController`: mapper-in-service, If-Match OCC fold on PATCH.
 *
 * Tenancy is service-enforced: rows are SYSTEM-shared-read (a tenant SEES the platform's
 * published agents as templates) but every write asserts ownership — a foreign id, and a
 * SYSTEM row for a tenant admin, both answer 404 (404-over-403, rule 04).
 *
 * `POST :id/validate` / `:id/publish` / `:id/deprecate` are state transitions, not CAS
 * writes, so they carry no `@RequiresIfMatch()` (the WorkflowDefinition call).
 */
@ApiBearerAuth()
@ApiTags('admin-agents')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent:manage')
@Controller('admin/agents')
@CanManage('Agent')
export class AgentAdminController {
  constructor(@Inject(IAgentService) private readonly agentService: IAgentService) {}

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s agent versions (optionally the SYSTEM templates too)' })
  @ApiQuery({ name: 'task', required: false, enum: AgentTask })
  @ApiQuery({ name: 'includeTemplates', required: false, type: Boolean, description: 'Also return SYSTEM’s published agents (read-only templates).' })
  @ApiResponse({ status: 200, type: [AgentResponse] })
  async fetchAll(@Query('task') task?: AgentTask, @Query('includeTemplates') includeTemplates?: string): Promise<AgentResponse[]> {
    return this.agentService.list(task, includeTemplates === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one agent version (own or SYSTEM template)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent).' })
  async fetchById(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.getById(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Every version of this agent’s lineage, newest first' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: [AgentResponse] })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent).' })
  async fetchVersions(@Param('id') id: string): Promise<AgentResponse[]> {
    return this.agentService.listVersions(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new DRAFT agent version for the caller tenant' })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'Invalid configuration — `code` + `findings` name what failed (MODEL_TASK_MISMATCH, CONFIG, SCHEMA…).' })
  async create(@Body() request: CreateAgentRequest): Promise<AgentResponse> {
    return this.agentService.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a DRAFT/VALIDATED agent version (If-Match OCC)',
    description:
      'Sparse patch. `If-Match` (RFC 7232) is REQUIRED and CAS’es against the row `_version`; drift → 412, missing header → 428. ' +
      'Rejected 400 if the row is PUBLISHED/DEPRECATED (branch a new version instead). An edit returns a VALIDATED row to DRAFT.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateAgentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<AgentResponse> {
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.agentService.update(id, effective, effective.expectedVersion);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an agent version (refused for the ACTIVE published version — deprecate it first)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 409, description: 'The row is the ACTIVE published version of its slug.' })
  async remove(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.deleteById(id);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run every publish-time check; stores the report and advances to VALIDATED when nothing blocks' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The row is PUBLISHED/DEPRECATED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async validate(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.validate(id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish an agent version (fails closed)',
    description:
      'Stamps `compiledConfig` (fully resolved references: model, fallback chain, pinned template, defaults) and, by default, elects this ' +
      'version ACTIVE for its slug. Refused 400 with `code` + `findings` when the model is unavailable (MODEL_UNAVAILABLE), the bound ' +
      'template is not APPROVED (TEMPLATE_NOT_APPROVED), the model’s task does not match (MODEL_TASK_MISMATCH) or a capability gate fails.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'Blocking findings — nothing was published; the report is stored on the row.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishAgentRequest): Promise<AgentResponse> {
    return this.agentService.publish(id, request ?? {});
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: 'Branch a new DRAFT version from ANY version (own lineage), or a new tenant lineage from a SYSTEM template',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant, or an unpublished SYSTEM draft).' })
  async newVersion(@Param('id') id: string, @Body() request: NewAgentVersionRequest): Promise<AgentResponse> {
    return this.agentService.newVersion(id, request ?? {});
  }

  @Post(':id/deprecate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The row is not PUBLISHED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async deprecate(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.deprecate(id);
  }
}
