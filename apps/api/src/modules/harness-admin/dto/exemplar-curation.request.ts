import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ExemplarCurationStatus } from '@arcaai/domains';

/**
 * Body for `PATCH /admin/harness/gate-edit-exemplars/:id/curation` (TASK-553 F-24).
 *
 * `status` is the ONLY writable field on a mined exemplar. Everything else is
 * derived from the WORM audit trail and the redacted RAW→SIGNED diff, so a wider
 * body would turn a curation decision into a rewrite of mined history.
 *
 * `@IsEnum` (plus the global `forbidNonWhitelisted` pipe) makes an unknown
 * verdict a 400 at the edge, before any tenancy lookup happens.
 */
export class ExemplarCurationRequest {
  @ApiProperty({
    enum: ExemplarCurationStatus,
    description: 'The curator verdict: APPROVED (may be shown to the model), REJECTED (never), or PENDING (back to the queue).',
    example: ExemplarCurationStatus.APPROVED,
  })
  @IsEnum(ExemplarCurationStatus)
  status: ExemplarCurationStatus;
}
