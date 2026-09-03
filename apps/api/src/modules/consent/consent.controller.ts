import {
  ConsentGrantResponse,
  CreateConsentGrantRequest,
  IConsentGrantService,
  ListConsentGrantsQuery,
  PaginatedConsentGrantResponse,
  RevokeConsentGrantRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch, ForbidApiKey, ForbidServiceAccount } from '../../decorators';

/**
 * `ConsentGrantController` — admin CRUD over `ConsentGrant`
 * (consent-abac; Task 10 item 3), mounted at
 * `/admin/consent-grants` (global prefix → `/api/v1/admin/consent-grants`).
 *
 * This is the ONLY write surface for grants — `PatientConsentGuard`
 * (`apps/api/src/guards/patient-consent.guard.ts`) only READS through
 * `assertConsent`/`checkConsent`; it never creates or revokes. Mirrors
 * `WebhookController`'s If-Match OCC fold on the mutating (revoke) route.
 *
 * Tenancy: `create` and `getByPatient` use the caller's own CLS tenant
 * (`ConsentGrantService.create`/`getByPatient` throw `ArgumentInvalidException`
 * without one); `revoke` is load-then-assert (cross-tenant id → 404, never a
 * 403 existence leak) — see `ConsentGrantService.revoke`.
 */
@ApiBearerAuth()
@ApiTags('admin-consent-grants')
@Controller('admin/consent-grants')
@CanManage('ConsentGrant')
// API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: patient consent grants are the PHI authorization root; added after s /admin/* sweep, so covered by no owner approval.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — 's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
// SVC-NOTE (owner decision D-3) — CLOSED to the machine class.
// Unlike the API-key note above, this is a decision about WHAT the surface is,
// not a conservative default awaiting classification: consent is an act of a
// PERSON. A grant recorded here asserts that a patient authorized a use of
// their data, and the platform can only substantiate that claim when a human
// identity stands behind the write. A machine identity recording consent on a
// person's behalf would produce a compliance artifact with nobody to attribute
// it to — and this is the only write surface for grants, so closing it closes
// the claim.
// Deliberately absent from the generated SDK surface, so an integrator gets no
// method that would always 403. Re-opening it is a new owner decision, not a
// code-review call.
@ForbidServiceAccount()
export class ConsentGrantController {
  constructor(
    @Inject(IConsentGrantService)
    private readonly consentGrantService: IConsentGrantService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Record a consent grant for the caller tenant (clinician/tenant-admin recorded — Q1)' })
  @ApiResponse({ status: 201, type: ConsentGrantResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input.' })
  async create(@Body() request: CreateConsentGrantRequest): Promise<ConsentGrantResponse> {
    return this.consentGrantService.create(request);
  }

  /**
   * The consent register. `externalPatientId` is OPTIONAL here
   * it was required, and returned a bare array, which made this route a
   * per-patient lookup rather than a governance surface: HOPE stores no
   * `Patient` model, so an admin auditing consent had no way to discover the
   * patient ids to ask about. Now paginated and tenant-wide, with the same
   * patient filter available when the caller does know the id.
   */
  // AUTH-NOTE: the class gate is `manage:ConsentGrant` (recording/revoking a
  // grant is tenant-admin work). The READ is clinician-reachable on purpose —
  // the Consultation Scribe pre-flights the patient's consent through this
  // route before Start, and a clinician (or a super admin impersonating one)
  // holds no `manage`; without this override every clinician session showed a
  // 403 before recording (hope-v2-dev 2026-09-03). `read` is granted
  // tenant-scoped to the clinician policy in seed/01-policy.ts; rows stay
  // tenant-owned, so cross-tenant reads still resolve to nothing.
  @Get()
  @CanRead('ConsentGrant')
  @ApiOperation({
    summary: 'List consent grants for the caller tenant',
    description:
      'Paginated register of `ConsentGrant` rows in the caller tenant. Filter by `externalPatientId` (trim-normalized, exact-case — Q3), ' +
      '`purpose`, and `state`. `state=ACTIVE` applies the SAME predicate the ABAC choke point evaluates (not revoked and not expired as of now), ' +
      'so an Active row here is exactly a row `assertConsent` would allow at that instant.',
  })
  @ApiResponse({ status: 200, type: PaginatedConsentGrantResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid query parameter.' })
  async list(@Query() query: ListConsentGrantsQuery): Promise<PaginatedConsentGrantResponse> {
    return this.consentGrantService.list(query);
  }

  @Patch(':id/revoke')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Revoke a consent grant (If-Match OCC)',
    description:
      'Blocks new gated calls from this instant (design.md §Error handling). ' +
      "Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and CAS'es " +
      'against the row `_version`; drift → 412, missing header → 428.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'ConsentGrant id' })
  @ApiResponse({ status: 200, type: ConsentGrantResponse })
  @ApiResponse({ status: 404, description: 'Grant not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async revoke(
    @Param('id') id: string,
    @Body() request: RevokeConsentGrantRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ConsentGrantResponse> {
    const effectiveRequest: RevokeConsentGrantRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.consentGrantService.revoke(id, effectiveRequest);
  }
}
