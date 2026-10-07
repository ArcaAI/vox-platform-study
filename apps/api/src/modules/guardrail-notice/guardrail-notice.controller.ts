import {
  AcknowledgeGuardrailNoticeRequest,
  GuardrailHoldResumeResponse,
  GuardrailNoticeAckResponse,
  GuardrailNoticeListResponse,
  IGuardrailNoticeService,
  ResumeGuardrailHoldRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Param, Post, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, ExpectedVersion, RequiredScopes, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { ConsultationAccessHelper } from '../consultation/consultation-access.helper';
import { ConsultationLifecycleVocabularyInterceptor } from '../consultation/consultation-lifecycle-vocabulary.interceptor';

const IF_MATCH_HEADER = {
  name: 'If-Match',
  description: 'RFC 7232 strong validator carrying the consultation version the client read (e.g. `"7"`).',
  required: true,
} as const;

const CLINICIAN_400 =
  '`CLINICIAN_REQUIRED` — a machine credential named no clinician; `CLINICIAN_NOT_ALLOWED` — a human named another clinician without SUPER_ADMIN/TENANT_ADMIN, or an API key named someone other than the human it is bound to.';

/** The If-Match version: `@RequiresIfMatch()` answers 428 before the handler; this keeps the answer for an in-process caller. */
function requireExpectedVersion(expectedVersion: number | undefined): number {
  if (expectedVersion === undefined) {
    throw new HttpException(
      { code: 'PRECONDITION_REQUIRED', message: 'If-Match header is required for this operation.' },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  return expectedVersion;
}

/**
 * TASK-1050 W2e — a consultation's guardrail notices on the BUSINESS plane (README §9.7.3–§9.7.5,
 * §9.8.1): read them, acknowledge one, resume a guardrail hold.
 *
 * A thin shell over `IGuardrailNoticeService`: the consultation access check first (another
 * tenant's consultation is 404), then the service. The commands use the WRITE check — the
 * clinician on the consultation, a holder of `manage:Consultation` (a tenant admin), or a
 * tenant-bound service account (OD-22) — and attribute the act to a named clinician: a machine
 * credential must name one (the TASK-933 shape). Both commands carry the consultation's If-Match.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
@RequiredScopes('consultation:session:write')
export class GuardrailNoticeController {
  constructor(
    private readonly access: ConsultationAccessHelper,
    @Inject(IGuardrailNoticeService) private readonly notices: IGuardrailNoticeService,
  ) {}

  @Get(':id/guardrail-notices')
  @RequiredScopes('consultation:session:read')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({
    summary: 'The consultation`s guardrail notices',
    description:
      'Every OPEN guardrail notice (warning, unverified, blocked) and the most recent acknowledged / resolved ones, oldest first — the standard `GuardrailNotice` v1 plus its state — and `unacknowledgedNoticeIds`. ' +
      'No content and no judge reasoning: `defaultMessage` is the fixed label of `messageKey`. The lifecycle stream points here (`noticeId`) when a hold begins.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiOkResponse({ type: GuardrailNoticeListResponse })
  @ApiResponse({ status: 403, description: 'The caller may not read this consultation.' })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant).' })
  async list(@Param('id') id: string): Promise<GuardrailNoticeListResponse> {
    await this.access.assertRead(id);
    return (await this.notices.list(id)) as unknown as GuardrailNoticeListResponse;
  }

  @Post(':id/guardrail-notices/:noticeId/ack')
  @HttpCode(HttpStatus.OK)
  @RequiresIfMatch()
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Acknowledge a guardrail notice',
    description:
      'The clinician`s attestation that they saw the notice (recorded with the actor, `acknowledgedVia: ack`, audited). The `If-Match` header carries the consultation version. ' +
      'An acknowledged notice is idempotent; a resolved one is 409. Acknowledging a block does not release its hold — resume it.',
  })
  @ApiHeader(IF_MATCH_HEADER)
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'noticeId', description: 'Guardrail notice ID' })
  @ApiOkResponse({ type: GuardrailNoticeAckResponse })
  @ApiResponse({ status: 400, description: CLINICIAN_400 })
  @ApiResponse({ status: 403, description: 'Only the assigned doctor, a consultation manager or a tenant-bound service account may acknowledge.' })
  @ApiResponse({ status: 404, description: 'Consultation or notice not found (or cross-tenant), or the named clinician is not a user of this tenant.' })
  @ApiResponse({ status: 409, description: '`GUARDRAIL_NOTICE_RESOLVED` — the notice is already resolved.' })
  @ApiResponse({ status: 412, description: 'The consultation changed since the client read it.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  // AUTH-NOTE: the decorator says `@Authorize()` + the session write scope; the real gate is the
  // consultation WRITE check (owner doctor, `manage:Consultation`, or a tenant-bound service
  // account — OD-22) in ConsultationAccessHelper, and the clinician attribution rule (TASK-933) in
  // GuardrailNoticeService. A consultation of another tenant is 404, never 403.
  async acknowledge(
    @Param('id') id: string,
    @Param('noticeId') noticeId: string,
    @Body() body: AcknowledgeGuardrailNoticeRequest | undefined,
    @ExpectedVersion() expectedVersion: number | undefined,
    @Req() req: RequestWithAuth,
  ): Promise<GuardrailNoticeAckResponse> {
    const version = requireExpectedVersion(expectedVersion);
    await this.access.assertWrite(id);
    return (await this.notices.acknowledge(id, noticeId, {
      expectedVersion: version,
      ...(body?.clinicianUserId !== undefined ? { clinicianUserId: body.clinicianUserId } : {}),
      caller: this.access.callerOf(req),
    })) as unknown as GuardrailNoticeAckResponse;
  }

  @Post(':id/guardrail-hold/resume')
  @HttpCode(HttpStatus.OK)
  // A consultation response, so it speaks the same status vocabulary as the other lifecycle verbs
  // (`X-Hope-Lifecycle: 2` → the real status; otherwise projected, with `Vary`).
  @UseInterceptors(ConsultationLifecycleVocabularyInterceptor)
  @RequiresIfMatch()
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Resume a guardrail hold',
    description:
      'Resolve the guardrail.blocked notice that holds the consultation: `item_excluded` (the flagged items leave every later LLM context), `item_edited` (an item was corrected since the block), ' +
      'or `acknowledged` (proceed once at warn weight, recorded as a SAFETY_OVERRIDE — not offered for a check whose platform floor is block). ' +
      'On the egress-redaction hold (EGRESS_REDACTION_UNAVAILABLE) `acknowledged` is the only resolution and means RETRY — no override is recorded. ' +
      'Processing returns to IDLE when no other block remains; the run paused on the notice re-executes its node, or a fresh governing run is dispatched. The client then sends `start`. ' +
      'Answers the consultation (status / processing / processingReason / version, like the other lifecycle verbs) plus `resolvedNoticeId`. ' +
      'Idempotent for the same resolution. The `If-Match` header carries the consultation version.',
  })
  @ApiHeader(IF_MATCH_HEADER)
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiOkResponse({ type: GuardrailHoldResumeResponse })
  @ApiResponse({ status: 400, description: `Invalid resolution, or ${CLINICIAN_400}` })
  @ApiResponse({ status: 403, description: 'Only the assigned doctor, a consultation manager or a tenant-bound service account may resume.' })
  @ApiResponse({ status: 404, description: 'Consultation or notice not found (or cross-tenant), or the named clinician is not a user of this tenant.' })
  @ApiResponse({
    status: 409,
    description:
      '`GUARDRAIL_OVERRIDE_NOT_ALLOWED` — `acknowledged` on a block-floor check; `GUARDRAIL_ITEM_NOT_EDITED` — no flagged item changed; ' +
      '`GUARDRAIL_NOTICE_NOT_RESUMABLE` — not a block notice; `GUARDRAIL_NOTICE_RESOLVED` — resolved with another resolution; ' +
      '`GUARDRAIL_RESOLUTION_NOT_APPLICABLE` — an item resolution on the egress-redaction hold (EGRESS_REDACTION_UNAVAILABLE names no item: `acknowledged` retries).',
  })
  @ApiResponse({ status: 412, description: 'The consultation changed since the client read it.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  // AUTH-NOTE: as `acknowledge` — the consultation WRITE check (OD-22) is the real gate, the
  // clinician attribution rule (TASK-933) names whose resolution it is, and the resolution rules
  // (OD-18, the platform block floor) are imperative in GuardrailNoticeService.
  async resume(
    @Param('id') id: string,
    @Body() body: ResumeGuardrailHoldRequest,
    @ExpectedVersion() expectedVersion: number | undefined,
    @Req() req: RequestWithAuth,
  ): Promise<GuardrailHoldResumeResponse> {
    const version = requireExpectedVersion(expectedVersion);
    await this.access.assertWrite(id);
    return (await this.notices.resumeHold(
      id,
      { noticeId: body.noticeId, resolution: body.resolution },
      {
        expectedVersion: version,
        ...(body.clinicianUserId !== undefined ? { clinicianUserId: body.clinicianUserId } : {}),
        caller: this.access.callerOf(req),
      },
    )) as unknown as GuardrailHoldResumeResponse;
  }
}
