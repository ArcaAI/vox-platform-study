import {
  CreateFeedbackRequest,
  FEEDBACK_TARGET_KINDS,
  FeedbackPageResponse,
  FeedbackReasonCodesResponse,
  FeedbackResponse,
  IActiveUserContext,
  IConsultationFeedbackService,
  IConsultationFeedbackServiceToken,
} from '@arcaai/applications';
import type { FeedbackTargetKindValue } from '@arcaai/applications';
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { ConsultationAccessHelper } from './consultation-access.helper';

export class FeedbackListQuery {
  @ApiPropertyOptional({ enum: FEEDBACK_TARGET_KINDS })
  @IsOptional()
  @IsIn(FEEDBACK_TARGET_KINDS)
  targetKind?: FeedbackTargetKindValue;

  @ApiPropertyOptional({ description: 'Only feedback on this context item.' })
  @IsOptional()
  @IsString()
  contextItemId?: string;

  @ApiPropertyOptional({ description: 'Include superseded entries (default: latest per actor + target).' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  includeHistory?: boolean;

  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Clinician feedback on a consultation. A thin shell: read-access check (404 cross-tenant), then
 * the feedback service, which owns validation of reasons, targets, corrections and idempotency.
 * Ratings and comments are accepted in every status, so the access check is the READ one.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
@RequiredScopes('consultation:session:write')
export class ConsultationFeedbackController {
  constructor(
    private readonly access: ConsultationAccessHelper,
    @Inject(IConsultationFeedbackServiceToken) private readonly feedback: IConsultationFeedbackService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  // Declared before `:id/feedback` so the literal `feedback/reason-codes` never binds as `:id`.
  @Get('feedback/reason-codes')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({
    summary: 'The effective feedback reason list for the caller tenant',
    description: 'Tenant value when set, else the platform list.',
  })
  @ApiResponse({ status: 200, type: FeedbackReasonCodesResponse })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  async reasonCodes(): Promise<FeedbackReasonCodesResponse> {
    return this.feedback.reasonCodes(this.cls.get('tenantId'));
  }

  @Post(':id/feedback')
  @HttpCode(HttpStatus.CREATED)
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Record feedback: rating, reasons, comment, media or a correction',
    description:
      'At least one of rating / comment / attachmentIds / correction. A rating needs a target; reasons only with `down`. A correction after approval is 409 CONSULTATION_APPROVED; version drift is 412.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Replays with the same key and body return the same entry.' })
  @ApiResponse({ status: 201, type: FeedbackResponse })
  @ApiResponse({ status: 400, description: 'FEEDBACK_REASON_UNKNOWN / FEEDBACK_EMPTY / FEEDBACK_TARGET_REQUIRED / FEEDBACK_ATTACHMENT_INVALID.' })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant).' })
  @ApiResponse({ status: 409, description: 'CONSULTATION_APPROVED, or Idempotency-Key conflict.' })
  @ApiResponse({ status: 412, description: 'The corrected item changed since `expectedVersion`.' })
  @ApiResponse({ status: 413, description: 'Comment too long.' })
  async create(
    @Param('id') id: string,
    @Body() body: CreateFeedbackRequest,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @Req() req: RequestWithAuth,
  ): Promise<FeedbackResponse> {
    await this.access.assertRead(id);
    return this.feedback.create(id, body, idempotencyKey, this.access.callerOf(req));
  }

  @Get(':id/feedback')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({ summary: 'List consultation feedback (keyset, newest first)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 200, type: FeedbackPageResponse })
  @ApiResponse({ status: 404, description: 'Consultation not found (or cross-tenant).' })
  async list(@Param('id') id: string, @Query() query: FeedbackListQuery): Promise<FeedbackPageResponse> {
    await this.access.assertRead(id);
    return this.feedback.list(id, {
      targetKind: query.targetKind,
      contextItemId: query.contextItemId,
      includeHistory: query.includeHistory,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
