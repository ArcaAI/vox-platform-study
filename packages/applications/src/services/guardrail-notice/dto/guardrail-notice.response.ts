import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationResponse } from '../../consultation/consultation/dto/consultation.response';
import {
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_DIRECTIONS,
  GUARDRAIL_HOLD_RESOLUTIONS,
  GUARDRAIL_NOTICE_ACTIONS,
  GUARDRAIL_NOTICE_MESSAGE_KEYS,
  GUARDRAIL_NOTICE_SEVERITIES,
  GUARDRAIL_NOTICE_TYPES,
} from '@arcaai/types';

export class GuardrailNoticeCheckResponse {
  @ApiProperty({ enum: GUARDRAIL_CHECK_IDS }) checkId!: string;
  @ApiPropertyOptional() category?: string;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_SEVERITIES }) severity!: string;
}

export class GuardrailNoticeAcknowledgementView {
  @ApiProperty() noticeId!: string;
  @ApiProperty() acknowledgedBy!: string;
  @ApiProperty({ enum: ['ack', 'approve', 'resume'] }) acknowledgedVia!: string;
  @ApiProperty() acknowledgedAt!: string;
}

/** A stored `GuardrailNotice` v1 plus its state. No content and no judge reasoning. */
export class GuardrailNoticeResponse {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty() noticeId!: string;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_TYPES }) type!: string;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) direction!: string;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_ACTIONS }) action!: string;
  @ApiProperty({ type: () => [GuardrailNoticeCheckResponse] }) checks!: GuardrailNoticeCheckResponse[];
  @ApiPropertyOptional() consultationId?: string;
  @ApiPropertyOptional() runId?: string;
  @ApiPropertyOptional() nodeId?: string;
  @ApiProperty({ type: [String] }) itemIds!: string[];
  @ApiProperty({ enum: GUARDRAIL_NOTICE_MESSAGE_KEYS }) messageKey!: string;
  @ApiProperty({ description: 'The fixed English label of messageKey — never content.' }) defaultMessage!: string;
  @ApiProperty() requiresAcknowledgement!: boolean;
  @ApiProperty() resumable!: boolean;
  @ApiProperty() policyVersion!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ enum: ['open', 'acknowledged', 'resolved'] }) status!: string;
  @ApiProperty({ type: () => GuardrailNoticeAcknowledgementView, nullable: true }) acknowledgement!: GuardrailNoticeAcknowledgementView | null;
  @ApiProperty({ type: String, enum: GUARDRAIL_HOLD_RESOLUTIONS, nullable: true }) resolution!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedAt!: string | null;
}

/** `GET consultations/:id/guardrail-notices` (the SDKs' `GuardrailNoticesResponse`). */
export class GuardrailNoticeListResponse {
  @ApiProperty({
    type: () => [GuardrailNoticeResponse],
    description: 'Every OPEN notice plus the most recent acknowledged / resolved ones, oldest first.',
  })
  notices!: GuardrailNoticeResponse[];

  @ApiProperty({ type: [String], description: 'The notices still awaiting an acknowledgement.' })
  unacknowledgedNoticeIds!: string[];
}

/** `POST consultations/:id/guardrail-notices/:noticeId/ack` — the updated notice and its acknowledgement. */
export class GuardrailNoticeAckResponse {
  @ApiProperty({ type: () => GuardrailNoticeResponse }) notice!: GuardrailNoticeResponse;
  @ApiProperty({ type: () => GuardrailNoticeAcknowledgementView }) acknowledgement!: GuardrailNoticeAcknowledgementView;
}

/**
 * `POST consultations/:id/guardrail-hold/resume` — the consultation lifecycle response the other
 * consultation verbs answer (its `version` is the new ETag), plus the notice the resume resolved.
 */
export class GuardrailHoldResumeResponse extends ConsultationResponse {
  @ApiProperty({ description: 'The guardrail.blocked notice this resume resolved.' })
  resolvedNoticeId!: string;
}
