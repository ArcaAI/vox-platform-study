import { IGuardrailTenantPolicyService, TenantGuardrailPolicyResponse, UpdateTenantGuardrailPolicyRequest } from '@arcaai/applications';
import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ExpectedVersion, ForbidApiKey, ForbidServiceAccount, RequiresIfMatch } from '../../decorators';

/**
 * `admin/guardrail/policy` — the CALLER tenant's guardrail on/off rules (TASK-1050 README §11.1). The
 * tenant is the CLS working tenant: the tenant admin's own, or a super admin's selected one. There is no
 * tenant id in the path, so there is no id space to probe.
 *
 * AUTH-NOTE: `read`/`manage:TenantGuardrailPolicy` (seeded on the tenant admin, tenant-pinned) decide who
 * reaches the route; they UNDERSTATE the real gate, a FIELD-LEVEL split gate enforced in
 * `GuardrailTenantPolicyService`, in this order: (1) existence — a non-super-admin aiming at another
 * tenant is 404 (404-over-403); (2) tier — the SYSTEM row is 403 here (row-independent; it is written
 * only through `admin/guardrail/availability/:tenantId`); (3) fields — a tenant admin may change ONLY
 * `directions.<dir>.enabled` and `checks.<id>.enabled` of a check no lock holds; any other changed field
 * is 403 `GUARDRAIL_FIELD_PLATFORM_ONLY`, and the catalogue-locked medical check is 403
 * `GUARDRAIL_CHECK_LOCKED` for everyone. A super admin on this route writes with the platform caller
 * class. Do not widen a decorator here without reading the service.
 *
 * Human-only: API keys are refused first (`@ForbidApiKey()`), and the service-account plane is refused
 * explicitly (the boot audit treats silence on an admin route as ambiguous).
 */
@ApiBearerAuth()
@ApiTags('admin-guardrail-availability')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/guardrail/policy')
export class GuardrailTenantPolicyController {
  constructor(
    @Inject(IGuardrailTenantPolicyService)
    private readonly policyService: IGuardrailTenantPolicyService,
  ) {}

  @Get()
  @CanRead('TenantGuardrailPolicy')
  @ApiOperation({
    summary: "Read the working tenant's guardrail rules",
    description:
      'Every guardrail check as it is IN FORCE for the tenant (tenant row → SYSTEM row → catalogue, field by field): on/off, the platform-set action (read-only for a tenant admin), locks with their reason, who set the value and whether it is inherited, plus the two screening directions. A tenant with no row answers `version: 0` — send `If-Match: "0"` to create one.',
  })
  @ApiResponse({ status: 200, type: TenantGuardrailPolicyResponse })
  @ApiResponse({ status: 400, description: 'No working tenant is selected (`WORKING_TENANT_REQUIRED`).' })
  @ApiResponse({ status: 403, description: 'The caller holds no `read:TenantGuardrailPolicy`.' })
  @ApiResponse({ status: 404, description: 'The working tenant is not the caller`s own (404-over-403).' })
  async get(): Promise<TenantGuardrailPolicyResponse> {
    return this.policyService.getOwn();
  }

  @Put()
  @CanManage('TenantGuardrailPolicy')
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Turn the working tenant's guardrail checks and screening directions on or off",
    description:
      'Only fields whose value DIFFERS from the policy in force count, so the whole view read by GET may be sent back. A tenant admin may change `directions.<dir>.enabled` (off = monitor only: still screened and recorded) and `checks.<id>.enabled` of a check no lock holds. At least one check per direction must stay on. Any other changed field is refused with 403 `GUARDRAIL_FIELD_PLATFORM_ONLY` (`fields` names them); the medical-domain check is locked for everyone (403 `GUARDRAIL_CHECK_LOCKED`). A committed change reaches guardrail at once (cache invalidation).',
  })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the version the client read (`"0"` creates the row).', required: true, example: '"0"' })
  @ApiResponse({ status: 200, type: TenantGuardrailPolicyResponse })
  @ApiResponse({ status: 400, description: 'Unknown check id, malformed field, no working tenant, or a direction left with no check (OD-8).' })
  @ApiResponse({ status: 403, description: '`GUARDRAIL_FIELD_PLATFORM_ONLY` / `GUARDRAIL_CHECK_LOCKED` (with `fields`), or the SYSTEM tier.' })
  @ApiResponse({ status: 404, description: 'The working tenant is not the caller`s own (404-over-403).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async put(
    @Body() request: UpdateTenantGuardrailPolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantGuardrailPolicyResponse> {
    return this.policyService.putOwn({ ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion });
  }
}
