import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  GuardrailEvaluationBatchRequestDto,
  GuardrailEvaluationBatchResponseDto,
  GuardrailEvaluationIngestService,
  TENANTLESS_PREFIX,
  type IActiveUserContext,
} from '@arcaai/applications';
import { Public } from '../../decorators';
import { InternalTenantLockGuard } from '../../guards/internal-tenant-lock.guard';
import { InternalServiceTokenGuard } from '../internal/internal-service-token.guard';

/**
 * The `?service=` selector guardrail's drainer sends (apps/guardrail, c72130ab8):
 * `InternalServiceTokenGuard` checks the token against that service's secret (or the shared one).
 */
export const GUARDRAIL_INGEST_SERVICE = 'guardrail';

/**
 * TASK-1050 W2e — `POST /api/v1/internal/guardrail/evaluations?service=guardrail`: guardrail's
 * outbox drainer delivers every evaluation it decided (README §9.8.2, OD-14 amended). The gateway
 * is the ONLY writer of guardrail outcomes; guardrail's database access stays read-only.
 *
 * Service-to-service only: `@Public()` exempts it from the user-JWT chain and
 * `InternalServiceTokenGuard` authenticates `X-Service-Token` for `service=guardrail` (the shared
 * `INTERNAL_ACCESS_TOKEN` or the legacy `GUARDRAIL_SERVICE_TOKEN`); the restore lock follows it
 * (`InternalTenantLockGuard`, a locked tenant answers 503 so the drainer redrives). `X-Tenant-Id`
 * is MANDATORY (owner directive 2026-08-16) and must equal every record's `tenantId` (400
 * otherwise); the write runs in a CLS context pinned to it, so the tenant-scope extension holds.
 *
 * Idempotent on `evaluationId`: a redriven batch answers `duplicates` and changes nothing.
 * Excluded from the published API document because it is an internal service contract, not a
 * client surface — it is still mounted and still guarded.
 */
@ApiExcludeController()
@Public()
@UseGuards(InternalServiceTokenGuard, InternalTenantLockGuard)
@Controller('internal/guardrail/evaluations')
export class GuardrailEvaluationInternalController {
  constructor(
    private readonly evaluations: GuardrailEvaluationIngestService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a batch of guardrail evaluations (guardrail outbox drain)',
    description:
      'At most 100 records. One transaction per batch: notices (deduped), evaluations (idempotent on evaluationId), item markers and, on a block, the consultation`s resumable guardrail hold.',
  })
  @ApiQuery({
    name: 'service',
    required: true,
    enum: [GUARDRAIL_INGEST_SERVICE],
    description: 'The calling service; selects the token the guard checks.',
  })
  @ApiResponse({ status: 200, type: GuardrailEvaluationBatchResponseDto })
  @ApiResponse({ status: 400, description: 'Missing X-Tenant-Id, a record of another tenant, or an invalid / oversized batch.' })
  @ApiResponse({ status: 401, description: 'Missing or wrong X-Service-Token.' })
  @ApiResponse({ status: 503, description: 'The tenant is locked by a checkpoint restore; redrive later.' })
  async ingest(
    @Body() body: GuardrailEvaluationBatchRequestDto,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<GuardrailEvaluationBatchResponseDto> {
    const tenantId = tenantIdHeader?.trim();
    if (!tenantId || (TENANTLESS_PREFIX && tenantId.startsWith(TENANTLESS_PREFIX))) {
      throw new BadRequestException('A tenant `X-Tenant-Id` is required — every guardrail evaluation belongs to a tenant.');
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.evaluations.ingest(tenantId, body);
    });
  }
}
