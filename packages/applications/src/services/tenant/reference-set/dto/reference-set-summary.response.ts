import { ApiProperty } from '@nestjs/swagger';
import type { ReferenceSetKind, ReferenceSetKindOutcome, ReferenceSetSyncMode } from '../ITenantReferenceSetService';

/** What one provisioning / re-sync run did, per kind (TASK-890 §3.4). */
export class ReferenceSetSummaryResponse {
  @ApiProperty({ description: 'The tenant the run acted on.' })
  tenantId!: string;

  @ApiProperty({ description: 'The mode the run used.', enum: ['missing-only', 'refresh-locked'] })
  mode!: ReferenceSetSyncMode;

  @ApiProperty({
    description: 'Per kind: rows added, rows left alone, rows whose copy failed.',
    type: 'object',
    additionalProperties: { type: 'object' },
  })
  kinds!: Record<ReferenceSetKind, ReferenceSetKindOutcome>;

  @ApiProperty({ description: 'One line per failure — a report a human can act on.', type: [String] })
  warnings!: string[];
}
