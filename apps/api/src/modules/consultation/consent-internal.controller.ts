import { ConsentAssertContext, ConsentDecision, IConsultationConsentService } from '@arcaai/applications';
import { ConsentPurpose } from '@arcaai/domains';
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from './harness-service-token.guard';

/**
 * Body for `POST /internal/consent/assert` (TASK-712, consent-abac Phase 4).
 *
 * The gateway-internal front door for the non-HTTP consent choke point
 * (README §4 Task 12, consent-design.md §4 option A+B hybrid): the harness
 * calls this from a Temporal ACTIVITY (never from workflow code — workflows
 * must stay deterministic, `.claude/rules/06-python-services.md` §Temporal)
 * before a gated MCP tool call or a RAG retrieval.
 *
 * Non-throwing by design: this wraps `checkConsent` (the decision-returning
 * half of `IConsultationConsentService`), never `assertConsent` — the caller
 * needs to distinguish a genuine denial from an unavailable lookup (R4) to
 * choose the right `ApplicationError` type and trajectory `error_code` on the
 * Python side, and an HTTP 4xx/5xx status code alone cannot carry that.
 */
class ConsentAssertRequestBody {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ description: 'External patient identifier (Consultation.patientId identifier space — trim-normalized on lookup).' })
  @IsString()
  @IsNotEmpty()
  externalPatientId: string;

  @ApiProperty({ enum: ConsentPurpose })
  @IsEnum(ConsentPurpose)
  purpose: ConsentPurpose;

  @ApiPropertyOptional({ description: 'Minimum-necessary scope bag (e.g. dateRangeDays/sourceSystems for HISTORY_RETRIEVAL).' })
  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  consultationId?: string;

  @ApiPropertyOptional({ description: 'The MCP tool name, when this assert is gating a tool call.' })
  @IsOptional()
  @IsString()
  toolName?: string;
}

/**
 * Response for `POST /internal/consent/assert`. Mirrors `ConsentDecision`
 * (`IConsultationConsentService`) — NEVER carries PHI, only the verdict +
 * bookkeeping ids.
 */
class ConsentAssertResponseBody {
  @ApiProperty()
  allowed: boolean;

  @ApiPropertyOptional({ description: "Denial reason (only meaningful when allowed=false and unavailable is not set — R4's 'denied' case)." })
  reason?: string;

  @ApiPropertyOptional({
    description: "Set (reason omitted) when the grant-store lookup itself failed — R4's 'unavailable' case, distinct from a genuine denial.",
  })
  unavailable?: boolean;

  @ApiPropertyOptional()
  grantId?: string;

  @ApiPropertyOptional({ nullable: true })
  expiresAt?: string | null;
}

/**
 * `ConsentInternalController` — the ONE gateway-internal HTTP front door for
 * `assertConsent`'s decision-returning sibling (README §4 Task 12).
 *
 * Reuses `HarnessServiceTokenGuard` (X-Service-Token, `.claude/rules/06-python-services.md`
 * §Gateway Integration) — the same auth the harness already uses for every
 * other callback into apps/api (`HarnessInternalController`). No new auth
 * mechanism is introduced.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/consent')
export class ConsentInternalController {
  constructor(
    @Inject(IConsultationConsentService)
    private readonly consentService: IConsultationConsentService,
  ) {}

  @Post('assert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Non-throwing consent check for non-HTTP callers (Temporal activities, workers).' })
  @ApiResponse({ status: 200, type: ConsentAssertResponseBody })
  async assert(@Body() body: ConsentAssertRequestBody): Promise<ConsentAssertResponseBody> {
    const context: ConsentAssertContext | undefined =
      body.consultationId || body.toolName ? { consultationId: body.consultationId, toolName: body.toolName } : undefined;

    const decision: ConsentDecision = await this.consentService.checkConsent({
      tenantId: body.tenantId,
      externalPatientId: body.externalPatientId,
      purpose: body.purpose,
      scope: body.scope,
      // The harness calls this from a Temporal activity, not on behalf of an
      // authenticated end user — 'workflow', mirroring assertConsent's
      // ConsentAssertActor.kind contract.
      actor: { kind: 'workflow' },
      context,
    });

    return {
      allowed: decision.allowed,
      reason: decision.reason,
      unavailable: decision.unavailable,
      grantId: decision.grantId,
      expiresAt: decision.expiresAt ? decision.expiresAt.toISOString() : null,
    };
  }
}
