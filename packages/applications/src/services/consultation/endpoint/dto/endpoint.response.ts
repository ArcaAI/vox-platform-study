import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** response DTOs for the three endpoint-stage routes. */

export class RecordSessionEndpointResponse {
  @ApiProperty({ description: 'Whether the consultation now carries an endpoint disposition.' })
  recorded!: boolean;

  @ApiProperty({
    description:
      'False when the same disposition was already stamped — the observable half of the idempotency contract, so a retried activity is distinguishable from a first write.',
  })
  changed!: boolean;

  @ApiProperty({ description: 'The recorded disposition (ENDED | TIMED_OUT | CANCELLED).' })
  reason!: string;
}

export class FinalizeDocumentsResponse {
  @ApiProperty({
    description:
      'EVERY document key of the consultation that was visited, sorted. This is the DD-3 evidence: a SOAP-only finalize would return one key.',
    type: [String],
  })
  documentKeys!: string[];

  @ApiProperty({ description: 'Sections locked by THIS call.' })
  lockedSections!: number;

  @ApiProperty({ description: 'Sections already LOCKED. On a retry this is the whole population and lockedSections is 0.' })
  alreadyLocked!: number;

  @ApiProperty({ description: 'Sections deliberately left writable (lockConfirmedOnly) or lost to an optimistic-concurrency check.' })
  skippedSections!: number;
}

export class CaptureFeedbackResponse {
  @ApiProperty({ description: 'Whether the endpoint feedback was recorded.' })
  captured!: boolean;

  @ApiProperty({ description: 'Advisory corrections promoted over the raw channel by this call.' })
  promotedCount!: number;

  @ApiProperty({ description: 'Proposals refused — not ACCEPTED, digest drift, a span that no longer matches, or an overlap.' })
  rejectedCount!: number;

  @ApiPropertyOptional({
    description: 'Deterministic key over the accepted proposal ids. A retry recomputes it, finds its own prior version, and promotes nothing.',
    nullable: true,
  })
  promotionKey!: string | null;

  @ApiProperty({ description: 'True when this exact set of acceptances had already been promoted.' })
  alreadyPromoted!: boolean;
}
