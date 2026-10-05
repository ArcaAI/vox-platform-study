import { ApiProperty } from '@nestjs/swagger';

export const FEEDBACK_ROLLUP_DIMENSIONS = [
  'day',
  'agentVersion',
  'model',
  'promptVersion',
  'section',
  'entityLabel',
  'reason',
  'targetKind',
] as const;
export type FeedbackRollupDimension = (typeof FEEDBACK_ROLLUP_DIMENSIONS)[number];

export interface FeedbackRollupFilters {
  from?: string;
  to?: string;
  groupBy: FeedbackRollupDimension[];
  agentSlug?: string;
  modelName?: string;
}

export class FeedbackRollupRow {
  @ApiProperty({ description: 'One entry per requested dimension.', type: 'object', additionalProperties: { type: 'string', nullable: true } })
  dimensions!: Record<string, string | null>;
  @ApiProperty() up!: number;
  @ApiProperty() down!: number;
  @ApiProperty() cleared!: number;
  @ApiProperty() comments!: number;
  @ApiProperty() corrections!: number;
  @ApiProperty() reasoned!: number;
}

export class FeedbackRollupResponse {
  @ApiProperty({ type: [FeedbackRollupRow] }) rows!: FeedbackRollupRow[];
  @ApiProperty() truncated!: boolean;
}

/**
 * Read side of the daily feedback rollup (dimensions and counts only, PHI-free). The rollup
 * service computes; this reader answers the admin query for the caller's tenant.
 */
export abstract class IFeedbackRollupReader {
  abstract query(filters: FeedbackRollupFilters): Promise<FeedbackRollupResponse>;
}
export const IFeedbackRollupReaderToken = Symbol('IFeedbackRollupReader');
