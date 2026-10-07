import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CONSULTATION_PROCESSING,
  CONSULTATION_STATUSES,
  type ActivityEntry,
  type ActivityRunRecord,
  type Aggregates,
  type ConsultationActivityPage,
  type ConsultationProcessing,
  type ConsultationStatus,
  type EncounterBlock,
  type EncounterRecap,
  type ItemVersionDetail,
  type ItemVersionSummary,
  type RunSummary,
} from '@arcaai/types';

export class EncounterGapResponse {
  @ApiProperty() fromAt!: string;
  @ApiProperty() toAt!: string;
  @ApiProperty() durationMs!: number;
}

export class EncounterBlockResponse implements EncounterBlock {
  @ApiProperty() seq!: number;
  @ApiProperty() visitType!: string;
  @ApiProperty({ type: String, nullable: true }) externalRef!: string | null;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ type: String, nullable: true }) endedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) recordingStartMs!: number | null;
  @ApiProperty({ type: Number, nullable: true }) recordingEndMs!: number | null;
  @ApiPropertyOptional({ type: EncounterGapResponse, description: "Idle time between this encounter's end and the next one's start." })
  gapAfter?: EncounterGapResponse;
}

export class RunSummaryResponse implements RunSummary {
  @ApiProperty() runId!: string;
  @ApiProperty() workflowSlug!: string;
  @ApiProperty({ oneOf: [{ type: 'number' }, { type: 'string' }] }) workflowVersion!: number | string;
  @ApiProperty() agentSlug!: string;
  @ApiProperty({ oneOf: [{ type: 'number' }, { type: 'string' }] }) agentVersion!: number | string;
  @ApiProperty() model!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() durationMs!: number;
  @ApiProperty() tokensIn!: number;
  @ApiProperty() tokensOut!: number;
  @ApiProperty() contextUsed!: number;
  @ApiProperty() contextWindow!: number;
  @ApiProperty({ type: Number, nullable: true }) costMicros!: number | null;
  @ApiProperty({ type: String, nullable: true }) costBasis!: string | null;
  @ApiProperty({ type: String, nullable: true }) stopReason!: string | null;
  @ApiProperty() startedAt!: string;
}

export class ActivityRunRecordResponse extends RunSummaryResponse implements ActivityRunRecord {
  @ApiProperty() id!: string;
  @ApiProperty() nodeId!: string;
  @ApiPropertyOptional() nodeLabel?: string;
  @ApiProperty() activityKind!: string;
  @ApiProperty({ type: Number, nullable: true }) outputCap!: number | null;
  @ApiProperty({ type: String, nullable: true }) deployment!: string | null;
  @ApiProperty() endedAt!: string;
  @ApiProperty() versionNumber!: number;
}

/** TASK-1050 §9.6 — the consultation's guardrail counts (no content). */
export class ActivityGuardrailAggregatesResponse {
  @ApiProperty({ description: 'Guardrail evaluations recorded for the consultation (one per request × direction).' }) evaluations!: number;
  @ApiProperty({ description: 'Evaluations decided warn.' }) warn!: number;
  @ApiProperty({ description: 'Evaluations decided block.' }) block!: number;
  @ApiProperty({ description: 'Evaluations where a check could not run and degraded (unverified).' }) unverified!: number;
  @ApiProperty({ description: 'Guardrail notices not yet acknowledged or resolved.' }) openNotices!: number;
}

export class ActivityAggregatesResponse implements Aggregates {
  @ApiProperty() aiRunCount!: number;
  @ApiProperty() tokensIn!: number;
  @ApiProperty() tokensOut!: number;
  @ApiProperty() costMicros!: number;
  @ApiProperty({ type: [String] }) costBasis!: string[];
  @ApiProperty() editedItems!: number;
  @ApiProperty() feedbackUp!: number;
  @ApiProperty() feedbackDown!: number;
  @ApiPropertyOptional({ type: () => ActivityGuardrailAggregatesResponse, description: 'TASK-1050 — the guardrail counts, when recorded.' })
  guardrail?: ActivityGuardrailAggregatesResponse;
}

export class ItemVersionSummaryResponse implements ItemVersionSummary {
  @ApiProperty() versionNumber!: number;
  @ApiProperty() changeSource!: string;
  @ApiProperty({ type: String, nullable: true }) changedBy!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) changeReason?: string | null;
  @ApiProperty() createdAt!: string;
}

export class ItemVersionDetailResponse extends ItemVersionSummaryResponse implements ItemVersionDetail {
  @ApiProperty() contextItemId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Decrypted snapshot.' }) content!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) mediaId?: string | null;
}

export class ConsultationActivityPageResponse implements ConsultationActivityPage {
  @ApiProperty() consultationId!: string;
  @ApiProperty({ enum: CONSULTATION_STATUSES }) status!: ConsultationStatus;
  @ApiProperty({ enum: CONSULTATION_PROCESSING }) processing!: ConsultationProcessing;
  @ApiPropertyOptional() processingReason?: string;
  @ApiProperty({ type: [EncounterBlockResponse] }) encounters!: EncounterBlockResponse[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description:
      'Oldest first. Each entry is discriminated by `entryType`: `item` (a context item with its latest version), `segment_run` (consecutive transcript segments of one encounter), `feedback`, or `lifecycle`.',
  })
  items!: ActivityEntry[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
  @ApiPropertyOptional({ type: ActivityAggregatesResponse, description: 'Admin plane, first page only.' })
  aggregates?: ActivityAggregatesResponse;
}

export class EncounterRecapCitationResponse {
  @ApiProperty() itemId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['segment', 'attachment'] }) kind!: 'segment' | 'attachment';
  @ApiPropertyOptional() t0Ms?: number;
}

export class EncounterRecapLineResponse {
  @ApiProperty() text!: string;
  @ApiProperty({ type: [EncounterRecapCitationResponse] }) citations!: EncounterRecapCitationResponse[];
}

export class EncounterRecapSectionResponse {
  @ApiProperty({ description: 'reason, findings, medicines, sent_for, since_then, still_open' }) key!: string;
  @ApiPropertyOptional() label?: string;
  @ApiProperty({ description: "The section's lines joined by newlines." }) text!: string;
  @ApiProperty({ type: [EncounterRecapLineResponse] }) lines!: EncounterRecapLineResponse[];
}

export class EncounterRecapResponse implements EncounterRecap {
  @ApiProperty() encounterSeq!: number;
  @ApiProperty() contextItemId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ description: 'Display-only plain rendering (`## Label` blocks for a structured recap); never an input to generation.' })
  text!: string;
  @ApiPropertyOptional({ type: [EncounterRecapSectionResponse] }) sections?: EncounterRecapSectionResponse[];
  @ApiProperty() generatedAt!: string;
  @ApiProperty() ledgerContextItemId!: string;
}
