import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for `POST /admin/harness/gate-edit-exemplars/:id/promote-to-golden-set`
 * (TASK-792 W3).
 *
 * Only the DESTINATION is caller-supplied. Every other field of the resulting
 * golden case is derived server-side — the transcript from the consultation, the
 * reference note from the exemplar's redacted signed note, and the provenance
 * label from the promotion itself. A wider body would let a caller hand-author
 * eval ground truth through a route whose whole purpose is that it does not.
 */
export class PromoteExemplarRequest {
  @ApiProperty({
    description: 'The golden set to add the promoted case to. Must belong to the same tenant as the exemplar.',
    example: '019400aa-0000-7000-8000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  goldenSetId: string;
}
