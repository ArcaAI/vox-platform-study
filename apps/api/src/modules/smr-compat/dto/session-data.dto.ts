import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

/**
 * v1 `ConversationSegment` — one transcript turn.
 * (SMR_Summary_Endpoints.md §3.1.1; frozen)
 */
export class ConversationSegmentDto {
  @ApiProperty({ description: 'Speaker label, e.g. "patient" / "provider"' })
  @IsString()
  speaker!: string;

  @ApiProperty({ description: 'Spoken text' })
  @IsString()
  text!: string;

  /**
   * The turn's ORIGINAL words when `text` holds a machine translation of them.
   *
   * Set by the gateway's Sarvam pre-translation step, not by v1 callers — the
   * frozen v1 wire shape has no such field, and every v1 client omits it. It is
   * accepted from the wire (the global pipe whitelists declared fields only) so
   * a caller that already holds a bilingual transcript can supply it directly.
   *
   * Present ⇒ `buildSummaryPrompt` renders both lines and makes THIS one
   * authoritative for clinical facts.
   */
  @ApiPropertyOptional({ description: 'Original untranslated text, when `text` is a machine translation' })
  @IsOptional()
  @IsString()
  original_text?: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the turn' })
  @IsString()
  timestamp!: string;

  @ApiPropertyOptional({ description: 'ASR confidence 0.0–1.0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional({ description: 'Free-form per-segment metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/** v1 `TestResult` — a structured investigation result. */
export class TestResultDto {
  @ApiProperty({ description: 'Test name' })
  @IsString()
  test_name!: string;

  @ApiProperty({ description: 'Test type, e.g. "lab" / "imaging"' })
  @IsString()
  test_type!: string;

  @ApiProperty({ description: 'Result value/text' })
  @IsString()
  result!: string;

  @ApiPropertyOptional({ description: 'ISO-8601 test date' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({ description: 'Reference range' })
  @IsOptional()
  @IsString()
  reference_range?: string;

  @ApiPropertyOptional({ description: 'Status, e.g. Normal/Abnormal/Critical' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Ordering provider' })
  @IsOptional()
  @IsString()
  ordering_provider?: string;
}

/** v1 `PreviousVisitRecord` — a structured prior encounter. */
export class PreviousVisitRecordDto {
  @ApiProperty({ description: 'ISO-8601 visit date' })
  @IsString()
  visit_date!: string;

  @ApiProperty({ description: 'Visit type' })
  @IsString()
  visit_type!: string;

  @ApiProperty({ description: 'Chief complaint' })
  @IsString()
  chief_complaint!: string;

  @ApiPropertyOptional({ description: 'Provider' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ description: 'Diagnosis' })
  @IsOptional()
  @IsString()
  diagnosis?: string;

  @ApiPropertyOptional({ description: 'Treatment' })
  @IsOptional()
  @IsString()
  treatment?: string;

  @ApiPropertyOptional({ description: 'Follow-up plan' })
  @IsOptional()
  @IsString()
  follow_up_plan?: string;

  @ApiPropertyOptional({ description: 'Visit summary' })
  @IsOptional()
  @IsString()
  visit_summary?: string;

  @ApiPropertyOptional({ description: 'Medications prescribed', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  medications_prescribed?: string[];

  @ApiPropertyOptional({ description: 'Tests ordered', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tests_ordered?: string[];
}

/**
 * v1 `SessionData` — the session to summarize.
 * (SMR_Summary_Endpoints.md §3.1.1; frozen)
 */
export class SessionDataDto {
  // No consultation/session is required to summarize: `session_id` is an OPTIONAL
  // free-form correlation string, echoed back on `SummaryResponse.session_id`.
  // When the caller omits it, the controller synthesizes a `smr-…` value so the
  // response contract still carries a valid id. It is NOT a v2 Consultation id.
  @ApiPropertyOptional({ description: 'Optional session correlation id (echoed back; a `smr-…` value is generated when omitted)' })
  @IsOptional()
  @IsString()
  session_id?: string;

  @ApiPropertyOptional({ description: 'Patient identifier' })
  @IsOptional()
  @IsString()
  patient_id?: string;

  @ApiPropertyOptional({ description: 'Provider identifier' })
  @IsOptional()
  @IsString()
  provider_id?: string;

  @ApiPropertyOptional({ description: 'Session type' })
  @IsOptional()
  @IsString()
  session_type?: string;

  @ApiProperty({ description: 'ISO-8601 session creation time' })
  @IsString()
  created_at!: string;

  @ApiPropertyOptional({ description: 'Transcript turns', type: [ConversationSegmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConversationSegmentDto)
  conversation_segments?: ConversationSegmentDto[];

  @ApiPropertyOptional({ description: 'Free-form patient info/context' })
  @IsOptional()
  @IsObject()
  patient_info?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Free-form session metadata (e.g. { language: "en" })' })
  @IsOptional()
  @IsObject()
  session_metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Structured test results', type: [TestResultDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestResultDto)
  test_results?: TestResultDto[];

  @ApiPropertyOptional({ description: 'Structured prior visits', type: [PreviousVisitRecordDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreviousVisitRecordDto)
  previous_visits?: PreviousVisitRecordDto[];
  @ApiPropertyOptional()
  @IsOptional()
  previous_visit_summary?: unknown;

  @ApiPropertyOptional({ description: 'Plain-text alternative for test results' })
  @IsOptional()
  @IsString()
  test_results_text?: string;

  @ApiPropertyOptional({ description: 'Plain-text alternative for prior visits' })
  @IsOptional()
  @IsString()
  previous_visits_text?: string;

  @ApiPropertyOptional({ description: 'Department-aware pre-summary to fold into context' })
  @IsOptional()
  @IsString()
  pre_summary_text?: string;
}
