import { IAgentPromoteToSystemService, PromoteAgentToSystemRequest, PromoteAgentToSystemResponse } from '@arcaai/applications';
import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * TASK-930 §6.1 — the AGENT half of the HOPE promotion process.
 *
 * A separate thin controller from `AgentAdminController`, mounted on the SAME `admin/agents`
 * path, for the reason `AgentPromotionController` is separate from the workflow-definition CRUD
 * surface: promotion is its own verb with its own privilege boundary and its own WORM record,
 * not another operation on an agent. Keeping it here also keeps it beside the workflow promotion
 * it mirrors, so the two halves of one owner decision are read together.
 *
 * There is deliberately no GET, PATCH or DELETE: the promotion RECORD is read through
 * `admin/agent-promotions`, and a correction is a new promotion.
 */
@ApiBearerAuth()
@ApiTags('admin-agents')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent:manage')
@Controller('admin/agents')
@CanManage('Agent')
export class AgentPromoteToSystemController {
  constructor(
    @Inject(IAgentPromoteToSystemService)
    private readonly service: IAgentPromoteToSystemService,
  ) {}

  // AUTH-NOTE: the class-level `@CanManage('Agent')` UNDERSTATES the real gate here. Writing into
  // SYSTEM is a PLATFORM-ADMIN privilege — "only the platform admin manages SYSTEM" (owner #4) —
  // and there is no "super admin" CASL subject to express it with; tenant admins legitimately
  // hold `manage:Agent` for every other operation on `admin/agents`. The real control is
  // `isSuperAdmin` inside `AgentPromoteToSystemService.assertElevatedTenantlessContext`, plus the
  // elevated tenant-less context the cross-tenant read/write mechanically requires. That is a
  // PRIVILEGE 403, not the 404-over-403 cross-tenant posture — a slug the Global build tenant
  // does not own is still a 404. Never widen this decorator without reading the service first.
  @Post('promote-to-system')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote an agent from the Global build tenant into the SYSTEM reference set',
    description:
      'The platform-admin path of owner decision #4 for an AGENT: build in Global (`50000000-…`), promote into SYSTEM ' +
      '(`00000000-…`), which is the reference set every customer tenant is provisioned from. Copies the Agent row and its ' +
      '`AgentModelFallback` chain into SYSTEM as a new version of the same slug (`max(versionNumber)+1`, so the previous ' +
      'SYSTEM version stays as history), re-resolves every model BY SLUG in the SYSTEM catalogue, then recompiles, PUBLISHES ' +
      'and ACTIVATES it — the half a tenant-to-tenant push (`POST admin/agents/{slug}/sync`) deliberately omits, because ' +
      'publishing into a customer tenant would re-point that customer’s live consultations and SYSTEM runs none. Referenced ' +
      'content travels with it: a Global-owned `instruction.promptTemplateId` is deep-copied into SYSTEM (APPROVED where the ' +
      'source was, `sourceTemplateId` stamped) and re-bound, while a SYSTEM-owned one is left alone; `contextSchemaId` binds ' +
      'the SYSTEM schema of the same slug, copied when SYSTEM carries none. `instruction.evalGate` is STRIPPED — a golden set ' +
      'is a corpus of encrypted PHI and not even the pointer crosses a tenant boundary. One WORM `AgentPromotion` record is ' +
      'written. Requires a platform administrator and an elevated tenant-less context.',
  })
  @ApiResponse({ status: 200, type: PromoteAgentToSystemResponse, description: 'The published SYSTEM agent version and what the promotion copied' })
  @ApiResponse({ status: 403, description: 'Not a platform administrator, or the context is not elevated and tenant-less.' })
  @ApiResponse({ status: 404, description: 'The Global build tenant has no such agent, or no such version in that lineage.' })
  @ApiResponse({
    status: 409,
    description:
      'The resolved Global version is not PUBLISHED (`AGENT_NOT_PUBLISHED`), the SYSTEM catalogue carries no model of a bound ' +
      'slug (`MODEL_NOT_RESOLVABLE`), or the bound context schema has no published version to copy (`CONTEXT_SCHEMA_NOT_PUBLISHED`).',
  })
  async promoteToSystem(@Body() request: PromoteAgentToSystemRequest): Promise<PromoteAgentToSystemResponse> {
    return this.service.promoteToSystem(request);
  }
}
