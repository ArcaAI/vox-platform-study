import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { FEEDBACK_RATINGS, FEEDBACK_TARGET_KINDS, FeedbackRatingValue, FeedbackTargetKindValue } from '../feedback-policy';

export class FeedbackTargetRequest {
  @ApiProperty({ enum: FEEDBACK_TARGET_KINDS })
  @IsIn(FEEDBACK_TARGET_KINDS)
  kind!: FeedbackTargetKindValue;

  @ApiProperty({ description: 'The ContextItem the feedback is about.' })
  @IsString()
  @MaxLength(64)
  contextItemId!: string;

  @ApiPropertyOptional({ description: 'The version rated; the server pins the current one when omitted.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;

  @ApiPropertyOptional({ description: 'The note section, for a SECTION target.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sectionKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  documentKey?: string;

  @ApiPropertyOptional({ description: 'The NamedEntity id, for an ENTITY target.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityRef?: string;
}

export class FeedbackCorrectionRequest {
  @ApiProperty({ description: 'The replacement text; becomes a new version of the target item.' })
  @IsString()
  @MaxLength(200_000)
  content!: string;

  @ApiPropertyOptional({ description: 'Optimistic-concurrency guard: the version the clinician edited from.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class FeedbackClientRequest {
  @ApiPropertyOptional({ example: 'hope-console' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  app?: string;

  @ApiPropertyOptional({ example: 'summary-panel' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  surface?: string;
}

/** `POST consultations/:id/feedback`. At least one of rating, comment, attachmentIds or correction. */
export class CreateFeedbackRequest {
  @ApiPropertyOptional({ type: FeedbackTargetRequest, description: 'Absent = consultation-level free text.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedbackTargetRequest)
  target?: FeedbackTargetRequest;

  @ApiPropertyOptional({ enum: FEEDBACK_RATINGS, description: "`cleared` withdraws the actor's earlier rating of the target." })
  @IsOptional()
  @IsIn(FEEDBACK_RATINGS)
  rating?: FeedbackRatingValue;

  @ApiPropertyOptional({ type: [String], description: 'Only with a `down` rating; validated against the effective reason list.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]{1,47}$/, { each: true })
  reasonCodes?: string[];

  @ApiPropertyOptional({ description: 'Free text; stored encrypted. The length ceiling is a setting, enforced by the service.' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ type: [String], description: 'READY `purpose=feedback` attachments backing this entry.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  attachmentIds?: string[];

  @ApiPropertyOptional({ type: FeedbackCorrectionRequest })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedbackCorrectionRequest)
  correction?: FeedbackCorrectionRequest;

  @ApiPropertyOptional({ type: FeedbackClientRequest })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedbackClientRequest)
  client?: FeedbackClientRequest;
}
