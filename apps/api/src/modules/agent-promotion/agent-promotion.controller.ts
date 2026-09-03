import {
  AgentPromotionResponse,
  IAgentPromotionService,
  PaginatedAgentPromotionResponse,
  PaginatedQuery,
  PromoteWorkflowRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Workflow promotion between tenants.
 *
 * A SEPARATE thin controller from the workflow-definition CRUD surface, because
 * promotion is its own immutable resource with its own lifecycle, not another
 * verb on a definition.
 *
 * There is deliberately no PATCH and no DELETE: an `AgentPromotion` is a WORM
 * audit record. A correction is a new promotion.
 *
 * The route path and the record's type name still say "agent" ( moved
 * the promotable from a `DepartmentAgentVersion` to a `WorkflowDefinition`
 * version, and the WORM table pre-dates that); everything a caller passes and
 * receives names what it actually is.
 */
@ApiBearerAuth()
@ApiTags('admin-agent-promotions')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent-promotion:manage')
@Controller('admin/agent-promotions')
@CanManage('WorkflowDefinition')
export class AgentPromotionController {
  constructor(
    @Inject(IAgentPromotionService)
    private readonly service: IAgentPromotionService,
  ) {}

  // AUTH-NOTE: the class-level `@CanManage('WorkflowDefinition')` UNDERSTATES
  // the real gate on this route. A permission decorator expresses `action +
  // subject`; it cannot express "…and also in that OTHER tenant". The actual
  // control — the actor holds `manage:WorkflowDefinition` in BOTH the source
  // and the target tenant, and with no environment/tenant-family concept it is
  // the ENTIRE control — is enforced imperatively in
  // `AgentPromotionService.assertManagesBothTenants`, which runs before any
  // read so the 403/404 difference is never an existence oracle. The route
  // additionally requires an elevated tenant-less context. Never widen or
  // "fix" this decorator without reading the service first.
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Promote a workflow definition version from one tenant to another',
    description:
      'Copies one immutable WorkflowDefinition version of a source-tenant workflow into the target tenant as a ' +
      'new DRAFT version of the same slug — never published, never active, so a cross-tenant push cannot ' +
      'silently become the workflow governing another tenant’s live consultations. Requires manage rights on ' +
      'BOTH tenants and an elevated tenant-less context. Tenant-owned prompt templates bound by the graph’s ' +
      'nodes are deep-copied into the target and the bindings rewritten; SYSTEM-owned ones are left alone. ' +
      'Every node’s `evalGate` is STRIPPED — a golden set is a corpus of encrypted PHI and not even the ' +
      'pointer crosses a tenant boundary, so the eval runs at the target against a target golden set the ' +
      'caller names. Blocked when a node binds a document template that is not SYSTEM-owned. Live ' +
      'consultations on the target are reported as a warning, never a block.',
  })
  @ApiResponse({ status: 201, description: 'The immutable promotion record', type: AgentPromotionResponse })
  @ApiResponse({
    status: 400,
    description: 'Blocked — a non-SYSTEM document-template binding, no ACTIVE PUBLISHED version to promote, or a same-tenant request',
  })
  @ApiResponse({ status: 403, description: 'The actor does not hold manage rights on both tenants, or the context is not elevated and tenant-less' })
  @ApiResponse({ status: 404, description: 'Source version not found (a cross-tenant id is indistinguishable from a missing one)' })
  async promote(@Body() request: PromoteWorkflowRequest): Promise<AgentPromotionResponse> {
    return this.service.promote(request);
  }

  @Get()
  @ApiOperation({
    summary: 'List promotions INTO the working tenant',
    description:
      'The target tenant’s own workflow lineage. Each row reports `drifted` — whether the target definition’s graph has been edited since it was promoted.',
  })
  @ApiQuery({ name: 'targetDefinitionSlug', required: false, type: String, description: 'Filter to one target workflow slug' })
  @ApiResponse({ status: 200, type: PaginatedAgentPromotionResponse })
  async list(@Query() query: PaginatedQuery, @Query('targetDefinitionSlug') targetDefinitionSlug?: string): Promise<PaginatedAgentPromotionResponse> {
    return this.service.list(query, targetDefinitionSlug);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one promotion record' })
  @ApiParam({ name: 'id', description: 'Promotion id', type: String })
  @ApiResponse({ status: 200, type: AgentPromotionResponse })
  @ApiResponse({ status: 404, description: 'Promotion not found (a cross-tenant id is indistinguishable from a missing one)' })
  async getById(@Param('id') id: string): Promise<AgentPromotionResponse> {
    return this.service.getById(id);
  }
}
