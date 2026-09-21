import { IConsultationTelemetryService, ConsultationTelemetryResponse } from '@arcaai/applications';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Per-consultation AI telemetry (TASK-999 Lane B).
 *
 * ## Why a separate controller from {@link AdminConsultationController}
 *
 * Same prefix, same gate, one route. It is split off because this surface reads
 * a DIFFERENT service over six tables the consultation service does not touch,
 * and keeping it here leaves the consultation admin controller free to change
 * for its own reasons. `admin/consultations/:id/telemetry` carries an extra
 * path segment, so it can never be captured by that controller's `:id` matcher
 * regardless of which registers first.
 *
 * ## Access — copied from the sibling, not invented
 *
 *   - `@CanManage('Consultation')` (class level) → TENANT_ADMIN / SUPER_ADMIN.
 *     A plain DOCTOR holds only owner-scoped `list/read Consultation`, never
 *     `manage`, so the guard answers 403 for them.
 *   - `@ForbidApiKey()` → every `/admin/*` route refuses the API-key class.
 *   - `@RequiredSvcScopes(...)` → the service-account class needs the same scope
 *     the sibling declares; without a declaration BOTH machine classes are
 *     denied by default.
 *
 * ## Tenancy
 *
 * A consultation belonging to another tenant answers **404, never 403**
 * (`05-nestjs-api.md` §Errors). The tenant-scope `$extends` nulls the row
 * inside the read and the service maps that to `NotFoundException`, so an
 * unknown id and a foreign id are indistinguishable to the caller.
 */
@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/consultations')
@CanManage('Consultation')
export class ConsultationTelemetryController {
  constructor(
    @Inject(IConsultationTelemetryService)
    private readonly telemetryService: IConsultationTelemetryService,
  ) {}

  @Get(':id/telemetry')
  @ApiOperation({
    summary: 'Per-consultation AI telemetry',
    description:
      'Session span, case-note counts, transcription, pre/partial/final summary, NER and guardrail activity for one consultation. ' +
      'Every block is independently resolved and says WHY it is empty — `NOT_RECORDED` (the platform does not capture it), ' +
      '`NO_ACTIVITY` (captured, none here) or `PRUNED` (retention removed it) — so the pane never renders a fabricated zero. ' +
      'Read-only; nothing is cached.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 200, type: ConsultationTelemetryResponse })
  @ApiResponse({ status: 404, description: 'Consultation not found, or not owned by the caller tenant (404-over-403).' })
  @ApiResponse({ status: 403, description: 'Caller lacks `manage:Consultation`, or presented an API key.' })
  async getTelemetry(@Param('id') id: string): Promise<ConsultationTelemetryResponse> {
    return this.telemetryService.getTelemetry(id);
  }
}
