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
  @ApiPropertyOptional({ type: EncounterGapResponse, description: 'Idle time between this encounter\'s end and the next one\'s start.' })
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

export class ActivityAggregatesResponse implements Aggregates {
  @ApiProperty() aiRunCount!: number;
  @ApiProperty() tokensIn!: number;
  @ApiProperty() tokensOut!: number;
  @ApiProperty() costMicros!: number;
  @ApiProperty({ type: [String] }) costBasis!: string[];
  @ApiProperty() editedItems!: number;
  @ApiProperty() feedbackUp!: number;
  @ApiProperty() feedbackDown!: number;
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

export class EncounterRecapSectionResponse {
  @ApiProperty() key!: string;
  @ApiPropertyOptional() label?: string;
  @ApiProperty() text!: string;
}

export class EncounterRecapResponse implements EncounterRecap {
  @ApiProperty() encounterSeq!: number;
  @ApiProperty() contextItemId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ description: 'Display-only; never an input to generation.' }) text!: string;
  @ApiPropertyOptional({ type: [EncounterRecapSectionResponse] }) sections?: EncounterRecapSectionResponse[];
  @ApiProperty() generatedAt!: string;
  @ApiProperty() ledgerContextItemId!: string;
}
