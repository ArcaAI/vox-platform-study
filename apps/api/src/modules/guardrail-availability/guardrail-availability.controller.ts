import {
  GuardrailAvailabilityResponse,
  GuardrailPolicyCatalogueEntryResponse,
  IGuardrailAvailabilityService,
  UpdateGuardrailAvailabilityRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, CanUpdate, ExpectedVersion, ForbidApiKey, RequiresIfMatch } from '../../decorators';

/**
 * Per-tenant guardrail AVAILABILITY — which safety policies apply to a tenant.
 *
 * AUTH-NOTE: the class-level `@CanManage('Tenant')` UNDERSTATES the real gate.
 * Every route here is SUPER_ADMIN-ONLY, enforced IMPERATIVELY in
 * `GuardrailAvailabilityService.assertSuperAdmin` (→ 403), because the
 * permission decorators express `action + subject` and cannot express "super
 * admins only": a tenant admin legitimately holds `manage:Tenant` for its OWN
 * tenant and would otherwise reach these routes. That is precisely the case the
 * owner ruled out — "no tenant admin manages any guardrail setting" — so a
 * tenant admin is refused even for its own tenant's row. Do not widen any
 * decorator here without reading the service first.
 *
 * This is a 403 PRIVILEGE boundary, deliberately NOT the 404-over-403
 * cross-tenant posture: the answer is "you may not administer guardrail",
 * which a 404 would misdescribe as "no such tenant".
 *
 * No `@RequiredSvcScopes` is declared, and that is deliberate rather than an
 * omission: an undeclared scope is a deny-by-default 403 for BOTH machine
 * credential classes (rule 05 §API Test Standard), which is the correct posture
 * for a surface only a human super administrator may reach.
 */
@ApiBearerAuth()
@ApiTags('admin-guardrail-availability')
@ForbidApiKey()
@Controller('admin/guardrail/availability')
@CanManage('Tenant')
export class GuardrailAvailabilityController {
  constructor(
    @Inject(IGuardrailAvailabilityService)
    private readonly availabilityService: IGuardrailAvailabilityService,
  ) {}

  @Get('catalogue')
  @ApiOperation({
    summary: 'List the selectable guardrail policies — SUPER_ADMIN only',
    description:
      'The catalogue is the ONLY legal vocabulary for a selection: every entry is a screening check that reads the selection, and an unknown id is refused (400) rather than dropped. Entries that carry a `threshold` declare which direction TIGHTENS it.',
  })
  @ApiResponse({ status: 200, type: [GuardrailPolicyCatalogueEntryResponse] })
  @ApiResponse({ status: 403, description: 'Caller is not a super administrator.' })
  @CanRead('Tenant')
  catalogue(): GuardrailPolicyCatalogueEntryResponse[] {
    return this.availabilityService.catalogue();
  }

  @Get()
  @ApiOperation({
    summary: 'List every tenant guardrail-availability row — SUPER_ADMIN only',
    description: 'The SYSTEM row is returned first: it is the platform default set every other tenant is read against, and inherits on absence.',
  })
  @ApiResponse({ status: 200, type: [GuardrailAvailabilityResponse] })
  @ApiResponse({ status: 403, description: 'Caller is not a super administrator.' })
  @CanRead('Tenant')
  async list(): Promise<GuardrailAvailabilityResponse[]> {
    return this.availabilityService.list();
  }

  @Get(':tenantId')
  @ApiOperation({
    summary: "Read one tenant's guardrail availability — SUPER_ADMIN only",
    description:
      'Returns the tenant\'s OWN selection plus the EFFECTIVE set after the `request tenant → SYSTEM` cascade, and which tier supplied it. A tenant with no row answers `version: 0` with an empty selection — not 404, because "no selection" is a fully resolved state that inherits the platform set. Send `If-Match: "0"` to create the row.',
  })
  @ApiParam({ name: 'tenantId', description: 'The tenant whose availability to read. `00000000-…` is the platform default row.' })
  @ApiResponse({ status: 200, type: GuardrailAvailabilityResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a super administrator.' })
  @CanRead('Tenant')
  async getForTenant(@Param('tenantId') tenantId: string): Promise<GuardrailAvailabilityResponse> {
    return this.availabilityService.getForTenant(tenantId);
  }

  @Put(':tenantId')
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Replace one tenant's guardrail availability under optimistic concurrency — SUPER_ADMIN only",
    description:
      'Availability SELECTS policies; it can never disable the gate. An empty selection means "no opinion" and inherits the SYSTEM set, and a selection that would leave a screening direction ungated is REFUSED (400). A threshold weaker than the SYSTEM row\'s is REFUSED (403) rather than silently clamped. `If-Match` carries the version from the prior GET: `"0"` creates the row, an existing version CASes against `_version`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiParam({ name: 'tenantId', description: 'The tenant whose availability to write. `00000000-…` is the platform default row.' })
  @ApiResponse({ status: 200, type: GuardrailAvailabilityResponse })
  @ApiResponse({ status: 400, description: 'Unknown policy id, malformed selection, or a selection that would leave a direction ungated.' })
  @ApiResponse({ status: 403, description: 'Caller is not a super administrator, or the selection would LOOSEN a policy below the platform floor.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  @CanUpdate('Tenant')
  async putForTenant(
    @Param('tenantId') tenantId: string,
    @Body() request: UpdateGuardrailAvailabilityRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<GuardrailAvailabilityResponse> {
    return this.availabilityService.putForTenant(tenantId, {
      ...request,
      expectedVersion: expectedFromHeader ?? request.expectedVersion,
    });
  }
}
