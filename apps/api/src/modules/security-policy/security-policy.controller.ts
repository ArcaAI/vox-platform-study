import { ISecurityPolicyService, SecurityPolicyResponse, UpdateSecurityPolicyRequest } from '@arcaai/applications';
import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CanManage, CanRead, ForbidApiKey, NoOptimisticConcurrency, RequiredSvcScopes } from '../../decorators';

/**
 * `GET/PUT /admin/security/policy` — the platform's credential policy as ONE
 * object: password complexity + rotation, and the entropy behind every machine
 * credential the platform issues.
 *
 * WHY, given `admin/settings/registry/:key` already reaches all eight keys: a
 * credential policy is only meaningful as a whole. An operator setting
 * "12 characters, four character classes, 32-byte machine secrets" should see
 * and set that in one round trip rather than reconstruct it from eight reads
 * and then work out which of eight writes failed.
 *
 * AUTH-NOTE: `@CanManage('GlobalSetting')` is NOT the real gate — a tenant
 * admin can legitimately hold that ability for its own tenant-scoped keys.
 * SUPER_ADMIN-only is enforced imperatively downstream by
 * `SettingsRegistryWriteService`, which refuses a `globalOnly` descriptor for a
 * non-super-admin with a 403; all eight keys of this policy are `globalOnly`.
 * That is a privilege boundary (403), not the 404-over-403 cross-tenant
 * posture — the policy is platform-wide and belongs to no tenant.
 */
@ApiTags('admin-security-policy')
@ApiBearerAuth()
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:settings:manage')
@Controller('admin/security')
export class SecurityPolicyController {
  constructor(@Inject(ISecurityPolicyService) private readonly service: ISecurityPolicyService) {}

  @Get('policy')
  @CanRead('GlobalSetting')
  @ApiOperation({
    summary: 'Read the platform credential policy.',
    description:
      'Returns the EFFECTIVE policy — stored `GlobalSetting` rows over the code defaults, read from the same cache the ' +
      'password validator and the credential issuers consult, so it is exactly what the next password check and the ' +
      'next credential issuance will apply. `bounds` carries the code-enforced entropy floor/ceiling, the surfaces ' +
      'whose alphabet is pinned (and therefore ignore `encoding`), and which credential surfaces the secret policy governs.',
  })
  @ApiResponse({ status: 200, type: SecurityPolicyResponse })
  @ApiResponse({ status: 403, description: 'The caller may not read platform settings.' })
  getPolicy(): SecurityPolicyResponse {
    return this.service.getPolicy();
  }

  @Put('policy')
  @CanManage('GlobalSetting')
  @NoOptimisticConcurrency(
    'multi-key write: the policy spans eight independent GlobalSetting rows with eight versions, so there is no single ' +
      'entity version an `If-Match` could precondition. Per-key compare-and-set remains available on the registry lane.',
  )
  @ApiOperation({
    summary: 'Update the platform credential policy (partial).',
    description:
      'Only the fields present are written, each through the single descriptor-driven enforcement point — which is what ' +
      'makes this route super-admin-only (403), type-checks each value, refreshes the cache every reader consults and ' +
      'broadcasts a sys-event per key. NOT transactional: each key is its own row, so a mid-request failure leaves the ' +
      'earlier keys applied. Every field is independently valid, so a partial application is a coherent policy — the ' +
      'response is the re-read effective policy, which is what the caller should trust. Secret-policy changes apply to ' +
      'the NEXT issuance only and never invalidate a credential already handed out.',
  })
  @ApiResponse({ status: 200, type: SecurityPolicyResponse })
  @ApiResponse({ status: 400, description: 'A value is out of bounds or the wrong type for its declared dataType.' })
  @ApiResponse({ status: 403, description: 'The credential policy is managed by super administrators only.' })
  async updatePolicy(@Body() request: UpdateSecurityPolicyRequest): Promise<SecurityPolicyResponse> {
    return this.service.updatePolicy(request);
  }
}
