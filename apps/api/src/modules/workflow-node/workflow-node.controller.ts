import { IWorkflowDefinitionService, WorkflowNodeRegistryResponse } from '@arcaai/applications';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanRead, ForbidApiKey } from '../../decorators';

/**
 * WorkflowNodeController — read-only projection of `WORKFLOW_NODE_REGISTRY`
 * (`@arcaai/workflow-contract`), mounted at `/admin/workflow-nodes` (global prefix ->
 * `/api/v1/admin/workflow-nodes`). TASK-734: closes the gap TASK-715 §6 risk #4 named — "the
 * registry endpoint is a new public-ish surface" — the platform's whole node vocabulary,
 * tenant-visible by design, no table, no migration (see `IWorkflowDefinitionService.listNodes`).
 *
 * Gated at the class level by `@CanRead('WorkflowDefinition')` (mirrors
 * `AgentTrajectoryController`'s "read-only, so `manage` would be overkill"): the registry is
 * not a persisted resource of its own (no Prisma model, no `ResourceType`) — it is metadata
 * ABOUT the resource this controller's sibling manages, read-gated the same way.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-nodes')
@ForbidApiKey()
@Controller('admin/workflow-nodes')
@CanRead('WorkflowDefinition')
export class WorkflowNodeController {
  constructor(
    @Inject(IWorkflowDefinitionService)
    private readonly workflowDefinitionService: IWorkflowDefinitionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the code-owned workflow node-type registry (the Studio’s node palette source)' })
  @ApiResponse({ status: 200, type: WorkflowNodeRegistryResponse })
  async fetchAll(): Promise<WorkflowNodeRegistryResponse> {
    return this.workflowDefinitionService.listNodes();
  }
}
