import {
  AgentPromotionResponse,
  IAgentPromotionService,
  PaginatedAgentPromotionResponse,
  PaginatedQuery,
  PromoteAgentRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Agent promotion between tenants.
 *
 * A SEPARATE thin controller from `DepartmentAgentController` — the
 * `DepartmentAgentResyncController` precedent — because promotion is its own
 * immutable resource with its own lifecycle, not another verb on the agent.
 *
 * There is deliberately no PATCH and no DELETE: an `AgentPromotion` is a WORM
 * audit record. A correction is a new promotion.
 */
@ApiBearerAuth()
@ApiTags('admin-agent-promotions')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent-promotion:manage')
@Controller('admin/agent-promotions')
@CanManage('DepartmentAgent')
export class AgentPromotionController {
  constructor(
    @Inject(IAgentPromotionService)
    private readonly service: IAgentPromotionService,
  ) {}

  // AUTH-NOTE: the class-level `@CanManage('DepartmentAgent')` UNDERSTATES the
  // real gate on this route. A permission decorator expresses `action +
  // subject`; it cannot express "…and also in that OTHER tenant". The actual
  // control — the actor holds `manage:DepartmentAgent` in BOTH the source and
  // the target tenant (D10, and with no environment/tenant-family
  // concept it is the ENTIRE control) — is enforced imperatively in
  // `AgentPromotionService.assertManagesBothTenants`, which runs before any
  // read so the 403/404 difference is never an existence oracle. The route
  // additionally requires an elevated tenant-less context. Never widen or
  // "fix" this decorator without reading the service first.
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Promote an agent configuration version from one tenant to another',
    description:
      'Copies the exact immutable DepartmentAgentVersion of a source-tenant agent into the target tenant, ' +
      'creating the target agent or advancing an existing one with the same slug. Requires manage rights on ' +
      'BOTH tenants and an elevated tenant-less context. Bound prompt templates are deep-copied into the ' +
      'target; the golden set is NOT — the eval re-runs at the target against the target’s own corpus, and no ' +
      'GoldenCase (nor the pointer to one) crosses a tenant boundary. Blocked when the target department does ' +
      'not declare a context kind the promoted agent subscribes to. Live consultations on the target are ' +
      'reported as a warning, never a block.',
  })
  @ApiResponse({ status: 201, description: 'The immutable promotion record', type: AgentPromotionResponse })
  @ApiResponse({
    status: 400,
    description: 'Blocked — missing target department, undeclared context kind, incumbent PRIMARY, or no version to promote',
  })
  @ApiResponse({ status: 403, description: 'The actor does not hold manage rights on both tenants, or the context is not elevated and tenant-less' })
  @ApiResponse({ status: 404, description: 'Source agent not found (a cross-tenant id is indistinguishable from a missing one)' })
  async promote(@Body() request: PromoteAgentRequest): Promise<AgentPromotionResponse> {
    return this.service.promote(request);
  }

  @Get()
  @ApiOperation({
    summary: 'List promotions INTO the working tenant',
    description:
      'The target tenant’s own agent lineage. Each row reports `drifted` — whether the target agent has been edited since it was promoted into.',
  })
  @ApiQuery({ name: 'targetAgentId', required: false, type: String, description: 'Filter to one target agent' })
  @ApiResponse({ status: 200, type: PaginatedAgentPromotionResponse })
  async list(@Query() query: PaginatedQuery, @Query('targetAgentId') targetAgentId?: string): Promise<PaginatedAgentPromotionResponse> {
    return this.service.list(query, targetAgentId);
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
