import {
  AgentAssignmentResponse,
  AgentTask,
  AsrLanguageCapabilityService,
  IAgentAssignmentService,
  UpsertAgentAssignmentRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Optional, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';

/**
 * AgentAssignmentAdminController — WHICH agent serves a task for a tenant or department
 * (TASK-863), mounted at `/admin/agent-assignments`. Authorization reuses `Agent`'s subject
 * and service scope: assigning an agent is agent-GOVERNANCE, not a new resource class (the
 * `WorkflowAssignmentController` precedent).
 */
@ApiBearerAuth()
@ApiTags('admin-agent-assignments')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent:manage')
@Controller('admin/agent-assignments')
@CanManage('Agent')
export class AgentAssignmentAdminController {
  constructor(
    @Inject(IAgentAssignmentService) private readonly assignments: IAgentAssignmentService,
    // TASK-1004 §4.5 — advisory language warnings for an ASR assignment. Optional: absent, the
    // response is exactly what it was.
    @Optional() private readonly languageCapability?: AsrLanguageCapabilityService,
  ) {}

  /**
   * TASK-1004 §4.5 — a SPEECH_TO_TEXT assignment decides the tenant's (or department's) engine, so
   * it is where an admin learns which spoken-language modes that engine serves only partially.
   * Advisory: the assignment is already written, and nothing is re-routed.
   */
  private async withLanguageWarnings(assignment: AgentAssignmentResponse): Promise<AgentAssignmentResponse> {
    if (assignment.task !== AgentTask.SPEECH_TO_TEXT || !this.languageCapability) return assignment;
    const warnings = await this.languageCapability.warningsForAgent(assignment.tenantId, assignment.agentSlug);
    return warnings.length > 0 ? { ...assignment, warnings } : assignment;
  }

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s agent assignments (plus SYSTEM’s platform defaults), optionally by task' })
  @ApiQuery({ name: 'task', required: false, enum: AgentTask })
  @ApiResponse({ status: 200, type: [AgentAssignmentResponse] })
  async fetchAll(@Query('task') task?: AgentTask): Promise<AgentAssignmentResponse[]> {
    return this.assignments.list(task);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one agent assignment' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentAssignmentResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s assignment).' })
  async fetchById(@Param('id') id: string): Promise<AgentAssignmentResponse> {
    return this.assignments.getById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create the assignment for one (scope, scopeId, task) tier' })
  @ApiResponse({ status: 201, type: AgentAssignmentResponse })
  @ApiResponse({ status: 400, description: 'Unsupported scope, or a slug with no ACTIVE PUBLISHED agent of that task visible to the tenant.' })
  @ApiResponse({ status: 404, description: 'The referenced department does not belong to the caller tenant.' })
  async create(@Body() request: UpsertAgentAssignmentRequest): Promise<AgentAssignmentResponse> {
    return this.withLanguageWarnings(await this.assignments.upsert(request));
  }

  @Patch()
  @RequiresIfMatch()
  @ApiOperation({ summary: 'Re-assign one tier (If-Match OCC)' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiResponse({ status: 200, type: AgentAssignmentResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Body() request: UpsertAgentAssignmentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<AgentAssignmentResponse> {
    return this.withLanguageWarnings(await this.assignments.upsert(request, expectedFromHeader ?? request.expectedVersion));
  }

  @Delete(':id')
  @RequiresIfMatch()
  @ApiOperation({ summary: 'Remove one assignment — the tier reverts to inheriting (WORM change row appended)' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({
    name: 'reason',
    required: false,
    description: 'Why the assignment is removed (WORM change row + audit). Required when the platform confirmation policy says so.',
  })
  @ApiResponse({ status: 200, type: AgentAssignmentResponse })
  @ApiResponse({ status: 400, description: 'CONFIRMATION_REQUIRED — the platform policy requires a reason.' })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s assignment).' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async remove(
    @Param('id') id: string,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('reason') reason?: string,
  ): Promise<AgentAssignmentResponse> {
    return this.assignments.remove(id, expectedFromHeader, reason ?? null);
  }
}
