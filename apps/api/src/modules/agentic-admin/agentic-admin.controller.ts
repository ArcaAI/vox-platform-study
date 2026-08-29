import { AgenticInstructionsResponse, IActiveUserContext, IAgenticInstructionsService, isSuperAdmin } from '@arcaai/applications';
import { BadRequestException, Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * AgenticAdminController — the super-admin control
 * plane's read-only agentic instruction inventory, mounted at `/admin/agentic/*`
 * (global prefix → `/api/v1/admin/agentic/*`). Mirrors `HarnessAdminController`'s
 * tenant-scope posture.
 *
 * `GET admin/agentic/instructions` returns the EFFECTIVE instruction set for one
 * tenant: the resolved prompt tier, the vendored (read-only) PDSQI judge-prompt
 * pin, the sensor thresholds, and the safety-criteria list.
 *
 * Scoping: tenant admins are pinned to their CLS tenant; a FOREIGN `?tenantId=`
 * is 404 (no-existence-leak posture — this is an admin config surface).
 * Super-admins (`isSuperAdmin`) target any tenant via `?tenantId=`.
 *
 * AUTHORIZATION: this controller DELIBERATELY keeps `@CanManage('HarnessPolicy')`
 * — the mcp-admin and agent-trajectory controllers were swapped to their own
 * subjects, but this one deliberately was not. The instructions
 * document is not a separate resource — it is a READ PROJECTION OF the harness
 * policy itself (resolved thresholds, safety criteria, prompt tier), so whoever
 * governs the policy governs this view of it. `manage` rather than `read`
 * because the aggregate exposes the full resolved platform configuration.
 */
@ApiBearerAuth()
@ApiTags('admin-agentic')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agentic:manage')
@Controller('admin/agentic')
@Authorize()
export class AgenticAdminController {
  constructor(
    @Inject(IAgenticInstructionsService)
    private readonly agenticInstructionsService: IAgenticInstructionsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('instructions')
  @CanManage('HarnessPolicy')
  @ApiOperation({
    summary: 'The effective agentic instruction set for a tenant (prompt tier, judge pin, thresholds, safety criteria)',
    description:
      'Read-only aggregate over the effective harness policy (sensor thresholds + safety), the prompt-resolution ' +
      'cascade (tier), and the vendored PDSQI judge-prompt pin (version/hash only — non-editable by license/science). ' +
      'Tenant admins are pinned to their own tenant; a foreign `?tenantId=` is 404.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'departmentId', required: false, description: 'Resolve the prompt tier against a department (omit = tenant baseline).' })
  @ApiQuery({
    name: 'promptType',
    required: false,
    type: String,
    description:
      'Prompt type to resolve the tier for: either a PHASE selector (`pre-summary`, `live`) or a VISIT-TYPE key from the tenant’s own ' +
      '`consultation.visitTypes` catalogue. Deliberately NOT an enum since TASK-815 §11 row 3 — visit type is tenant-admin defined, so a ' +
      'fixed three-value list could only ever answer for the platform’s two. Omitted ⇒ the tenant’s own initial-visit type.',
  })
  @ApiResponse({ status: 200, type: AgenticInstructionsResponse })
  @ApiResponse({ status: 404, description: 'Cross-tenant request from a tenant-bound caller (no existence leak).' })
  async getInstructions(@Query() query: { tenantId?: string; departmentId?: string; promptType?: string }): Promise<AgenticInstructionsResponse> {
    const tenantId = this.resolveTenantId(query.tenantId);
    return this.agenticInstructionsService.getEffectiveInstructions(tenantId, {
      departmentId: query.departmentId,
      promptType: query.promptType,
    });
  }

  /**
   * Resolve the effective read tenant. Super-admins target `?tenantId=` (falling
   * back to the elevated working tenant). Tenant-bound callers are pinned to their
   * own tenant; a FOREIGN `?tenantId=` yields 404 (no-existence-leak posture).
   */
  private resolveTenantId(queryTenantId?: string): string {
    const user = this.cls.get('user');
    const callerTenantId = this.cls.get('tenantId') ?? user?.tenantId ?? undefined;

    if (isSuperAdmin(user)) {
      const target = queryTenantId ?? callerTenantId;
      if (!target) {
        throw new BadRequestException('Platform admins must pass ?tenantId= to scope this request.');
      }
      return target;
    }

    if (!callerTenantId) {
      throw new BadRequestException('Tenant context is required.');
    }
    if (queryTenantId && queryTenantId !== callerTenantId) {
      throw new NotFoundException('Agentic instructions not found');
    }
    return callerTenantId;
  }
}
