import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FEEDBACK_RATINGS, FEEDBACK_TARGET_KINDS, FeedbackRatingValue, FeedbackTargetKindValue } from '../feedback-policy';

export class FeedbackTargetResponse {
  @ApiProperty({ enum: FEEDBACK_TARGET_KINDS }) kind!: FeedbackTargetKindValue;
  @ApiProperty() contextItemId!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) versionNumber?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) sectionKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) documentKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) entityRef?: string | null;
}

export class FeedbackCorrectionResponse {
  @ApiProperty() contextItemId!: string;
  @ApiProperty() versionNumber!: number;
}

export class FeedbackActorResponse {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['jwt', 'api-key', 'service-account'] }) credentialClass!: string;
}

export class FeedbackClientResponse {
  @ApiPropertyOptional({ type: String, nullable: true }) app?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) surface?: string | null;
}

/** What the rating was about: the producing agent, model and prompt, never any content. */
export class FeedbackProvenanceResponse {
  @ApiPropertyOptional({ type: String, nullable: true }) agentSlug?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) agentVersion?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) modelName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) promptVersion?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) workflowRunId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) activityRunId?: string | null;
}

export class FeedbackResponse {
  @ApiProperty() id!: string;
  @ApiProperty() consultationId!: string;
  @ApiProperty({ type: FeedbackTargetResponse, nullable: true }) target!: FeedbackTargetResponse | null;
  @ApiProperty({ enum: FEEDBACK_RATINGS, nullable: true }) rating!: FeedbackRatingValue | null;
  @ApiProperty({ type: [String] }) reasonCodes!: string[];
  @ApiProperty({ type: String, nullable: true, description: 'Decrypted for a reader who may see it.' }) comment!: string | null;
  @ApiProperty({ type: [String] }) attachmentIds!: string[];
  @ApiProperty({ type: FeedbackCorrectionResponse, nullable: true }) correction!: FeedbackCorrectionResponse | null;
  @ApiProperty() isLatest!: boolean;
  @ApiPropertyOptional({ description: 'The earlier entry this one replaced as the actor\'s latest for the target.' }) supersedes?: string;
  @ApiProperty({ type: FeedbackProvenanceResponse, nullable: true }) provenance!: FeedbackProvenanceResponse | null;
  @ApiProperty({ type: FeedbackActorResponse }) actor!: FeedbackActorResponse;
  @ApiProperty({ type: FeedbackClientResponse }) client!: FeedbackClientResponse;
  @ApiProperty() createdAt!: string;
}

export class FeedbackReasonResponse {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ enum: FEEDBACK_TARGET_KINDS, isArray: true }) appliesTo?: FeedbackTargetKindValue[];
}

/** `GET consultations/feedback/reason-codes`. */
export class FeedbackReasonCodesResponse {
  @ApiProperty({ type: [FeedbackReasonResponse] }) items!: FeedbackReasonResponse[];
  @ApiProperty({ enum: ['tenant', 'system'] }) source!: 'tenant' | 'system';
}
