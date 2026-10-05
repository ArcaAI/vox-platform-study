import { ApiProperty } from '@nestjs/swagger';
import type { EncounterSummary } from '@arcaai/types';

/**
 * One encounter (visit) of a consultation. A consultation is an episode: each visit the clinician
 * documents under it is an encounter, numbered from 1; `currentEncounterSeq` on the consultation
 * names the open one.
 */
export class EncounterResponse implements EncounterSummary {
  @ApiProperty({ description: 'Encounter number within the consultation, starting at 1.', example: 1 })
  seq: number;

  @ApiProperty({ description: 'The visit type of this encounter.', enum: ['new-visit', 'revisit'], example: 'new-visit' })
  visitType: string;

  @ApiProperty({
    description: "The caller's own id for this visit (an EMR event id), or null. A later `open` with the same id returns this consultation.",
    type: String,
    nullable: true,
    example: 'EVT-88213',
  })
  externalRef: string | null;

  @ApiProperty({ description: 'When the encounter started (ISO-8601).' })
  startedAt: string;

  @ApiProperty({ description: 'When the encounter ended (ISO-8601), or null while it is the open one.', type: String, nullable: true })
  endedAt: string | null;

  @ApiProperty({
    description: 'Where this encounter starts on the consultation recording timeline (ms), or null before any audio.',
    type: Number,
    nullable: true,
  })
  recordingStartMs: number | null;

  @ApiProperty({ description: 'Where this encounter ends on the consultation recording timeline (ms), or null.', type: Number, nullable: true })
  recordingEndMs: number | null;
}
