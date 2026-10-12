import {
  GuardrailEvaluationAdminService,
  GuardrailEvaluationListQuery,
  GuardrailEvaluationPageResponse,
  GuardrailNoticeListResponse,
  GuardrailWithheldContentResponse,
  IGuardrailNoticeService,
} from '@arcaai/applications';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * TASK-1050 W2e — the admin read plane over a consultation's guardrail evaluations (README §9.6,
 * §9.7.6): the keyset-paged evaluation grid (verdicts, no content) and the withheld output of an
 * outbound block. Every route acts on the caller's CLS tenant; another tenant's consultation is 404.
 */
@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/consultations')
@CanRead('Consultation')
export class AdminGuardrailEvaluationController {
  constructor(
    private readonly evaluations: GuardrailEvaluationAdminService,
    @Inject(IGuardrailNoticeService) private readonly noticeService: IGuardrailNoticeService,
  ) {}

  // AUTH-NOTE: the same class gate as the evaluation grid (read:Consultation, no API key, the admin
  // service scope). The business-plane twin (`consultations/:id/guardrail-notices`) is session-scoped
  // and refuses a tenant administrator who is not the consultation's clinician; this admin read lists
  // the same content-free notices for the working tenant. The service resolves the consultation inside
  // the CLS tenant, so another tenant's consultation is 404.
  @Get(':id/guardrail-notices')
  @ApiOperation({
    summary: 'List a consultation`s guardrail notices (admin)',
    description:
      'Every OPEN guardrail notice and the most recent acknowledged / resolved ones, oldest first, plus `unacknowledgedNoticeIds`. No content and no judge reasoning.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiOkResponse({ type: GuardrailNoticeListResponse })
  @ApiResponse({ status: 404, description: 'No such consultation in this tenant.' })
  async notices(@Param('id') id: string): Promise<GuardrailNoticeListResponse> {
    return (await this.noticeService.list(id)) as unknown as GuardrailNoticeListResponse;
  }

  @Get(':id/guardrail-evaluations')
  @ApiOperation({
    summary: 'List a consultation`s guardrail evaluations',
    description:
      'One row per guardrail evaluation (request × direction), newest first, keyset-paged: decision, per-check verdicts, models, latencies, the regions and items screened, ' +
      'and the notices raised. No content and no judge reasoning. Filters: `action` (the decision), `direction`, `check`, `runId`, `runKey`.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiOkResponse({ type: GuardrailEvaluationPageResponse })
  @ApiResponse({ status: 400, description: 'Invalid filter, limit or cursor.' })
  @ApiResponse({ status: 404, description: 'No such consultation in this tenant.' })
  async list(@Param('id') id: string, @Query() query: GuardrailEvaluationListQuery): Promise<GuardrailEvaluationPageResponse> {
    return (await this.evaluations.list(id, query)) as unknown as GuardrailEvaluationPageResponse;
  }

  // AUTH-NOTE: the class decorator UNDERSTATES this route's gate — the withheld output can quote
  // patient data, so GuardrailEvaluationAdminService admits only a SUPER_ADMIN, a TENANT_ADMIN of the
  // working tenant (tenant-scoped role read) or a service account (assertPromptInspectorAccess,
  // 403 `GUARDRAIL_WITHHELD_FORBIDDEN`; a doctor holding read:Consultation is refused). Row-
  // independent, so it runs before the consultation is resolved; another tenant's consultation or
  // evaluation is still 404 for an admin. Every read is audited.
  @Get(':id/guardrail-evaluations/:evaluationId/withheld')
  @ApiOperation({
    summary: 'Read the output an outbound guardrail block withheld, decrypted',
    description:
      'The generation a guardrail block kept from the client, decrypted from Vault-Transit ciphertext, for false-positive review. Never returned on the business plane and never fed to a later run. Audited.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'evaluationId', description: 'Guardrail evaluation ID' })
  @ApiOkResponse({ type: GuardrailWithheldContentResponse })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`GUARDRAIL_WITHHELD_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation or evaluation in this tenant, or nothing was withheld.' })
  async withheld(@Param('id') id: string, @Param('evaluationId') evaluationId: string): Promise<GuardrailWithheldContentResponse> {
    return this.evaluations.getWithheld(id, evaluationId);
  }
}
