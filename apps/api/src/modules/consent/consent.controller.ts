import { ConsentGrantResponse, CreateConsentGrantRequest, IConsentGrantService, RevokeConsentGrantRequest } from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, ForbidServiceAccount } from '../../decorators';

/**
 * `ConsentGrantController` — admin CRUD over `ConsentGrant`
 * (TASK-712, consent-abac; README §4 Task 10 item 3), mounted at
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
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: patient consent grants are the PHI authorization root; added after TASK-708 s /admin/* sweep, so covered by no owner approval.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
// SVC-NOTE (TASK-773, owner decision D-3) — CLOSED to the machine class.
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

  @Get()
  @ApiOperation({ summary: "List a patient's consent grants within the caller tenant" })
  @ApiQuery({ name: 'externalPatientId', required: true, description: 'External patient identifier (trim-normalized on lookup — Q3)' })
  @ApiResponse({ status: 200, type: [ConsentGrantResponse] })
  async getByPatient(@Query('externalPatientId') externalPatientId: string): Promise<ConsentGrantResponse[]> {
    return this.consentGrantService.getByPatient(externalPatientId);
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
