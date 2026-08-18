import {
  CreateServiceAccountRequest,
  getAvailableServiceAccountScopes,
  IServiceAccountService,
  ServiceAccountResponse,
  ServiceAccountSecretResponse,
  UpdateServiceAccountRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ExpectedVersion, ForbidApiKey, ForbidServiceAccount, RequiresIfMatch } from '../../decorators';

/**
 * `admin/service-accounts` — issuance and lifecycle of the platform-issued
 * machine identity (TASK-762).
 *
 * ─── AUTH-NOTE: the decorators UNDERSTATE the real gate, deliberately ───────
 *
 * The class-level `@CanManage('ServiceAccount')` exists so the deny-by-default
 * boot audit stays green and so the route is expressible in CASL at all. It is
 * NOT the gate. `ServiceAccountService.assertMayIssue()` additionally requires
 * SUPER_ADMIN on every write, which is the sanctioned "super-admin-only action
 * on a resource whose ability tenant admins could otherwise hold" pattern from
 * `05-nestjs-api.md` §"Imperative Privilege Checks".
 *
 * This matters because it is exactly the TASK-756 defect it avoids: the API-key
 * minting route is `@CanManage('ApiKey')`, a TENANT-ADMIN-reachable ability, and
 * that is how a tenant admin could mint a key carrying `admin:*`. Issuing a
 * machine identity must be strictly stricter than that ceiling — not equal to
 * it — so the check is unconditional and imperative rather than expressed as
 * an ability anyone can be granted.
 *
 * ─── Both exclusion decorators, for two different reasons ──────────────────
 *
 * `@ForbidApiKey()` — no tenant API key may ever reach machine-identity
 * issuance; that would be a key-path escalation straight into minting a
 * credential the key's own scope ceiling never permitted.
 *
 * `@ForbidServiceAccount()` — no service account may mint another. No
 * self-replication and no privilege loop, even for a platform account holding
 * `svc:*` and SUPER_ADMIN. (The service refuses this independently; the
 * decorator makes it a guard-level refusal that never reaches business logic,
 * and boot-audit E pins that both are present.)
 *
 * There is deliberately NO `@RequiredSvcScopes(...)` on this controller: a
 * scope declaration would make it a machine-reachable surface, which is the
 * opposite of what `@ForbidServiceAccount()` says.
 */
@ApiBearerAuth()
@ApiTags('admin-service-accounts')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/service-accounts')
@CanManage('ServiceAccount')
export class ServiceAccountController {
  constructor(@Inject(IServiceAccountService) private readonly serviceAccounts: IServiceAccountService) {}

  @Get('scopes')
  @ApiOperation({
    summary: 'List available svc:* service-account scopes',
    description: 'The `svc:*` namespace is separate from the tenant API-key `admin:*` vocabulary; neither is valid in the other place.',
  })
  @CanRead('ServiceAccount')
  getAvailableScopes() {
    return getAvailableServiceAccountScopes();
  }

  @Post()
  @ApiOperation({
    summary: 'Issue a service account (SUPER_ADMIN only)',
    description:
      'Creates a machine identity and returns its client secret EXACTLY ONCE. The secret is not persisted in any recoverable form and cannot be retrieved again — use `POST :id/rotate` if it is lost.',
  })
  @ApiResponse({ status: 201, description: 'Created. Client secret returned once and never again.' })
  @ApiResponse({ status: 403, description: 'Caller is not a SUPER_ADMIN, or is itself a service account (no self-replication).' })
  async create(@Body() request: CreateServiceAccountRequest): Promise<ServiceAccountSecretResponse> {
    return this.serviceAccounts.create(request);
  }

  @Get()
  @ApiOperation({ summary: 'List service accounts in scope' })
  @CanRead('ServiceAccount')
  async getAll(): Promise<ServiceAccountResponse[]> {
    return this.serviceAccounts.getAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one service account. Never returns credential material.' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 404, description: 'Not found — also returned for an account owned by another tenant (404-over-403).' })
  @CanRead('ServiceAccount')
  async getById(@Param('id') id: string): Promise<ServiceAccountResponse> {
    return this.serviceAccounts.getById(id);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a service account (SUPER_ADMIN only)',
    description:
      'Optimistic concurrency is enforced: `If-Match` (RFC 7232) is REQUIRED and compared against the row `_version`. Missing header is 428; drift is 412. Widening scopes is issuance by another name and carries the same SUPER_ADMIN gate. A successful update purges the account live tokens, so a narrowed account stops serving on old authority within one request.',
  })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the version the client read (e.g. `"7"`).', required: true, example: '"7"' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateServiceAccountRequest,
    @ExpectedVersion() expectedVersion: number | undefined,
  ): Promise<ServiceAccountResponse> {
    return this.serviceAccounts.update(id, request, expectedVersion ?? 0);
  }

  @Post(':id/rotate')
  @ApiOperation({
    summary: 'Rotate the client secret (SUPER_ADMIN only)',
    description:
      'Two-slot rotation with a bounded overlap: during the window BOTH the old and the new secret exchange successfully, so a consumer rotates without downtime. After the window only the new one does.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Rotated. New client secret returned once and never again.' })
  @HttpCode(200)
  async rotate(@Param('id') id: string): Promise<ServiceAccountSecretResponse> {
    return this.serviceAccounts.rotate(id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revoke a service account (SUPER_ADMIN only)',
    description: 'Soft-deletes the account AND purges its live tokens immediately. Revocation is effective within one request, not one token TTL.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 204, description: 'Revoked.' })
  @HttpCode(204)
  async revoke(@Param('id') id: string): Promise<void> {
    return this.serviceAccounts.revoke(id);
  }
}
