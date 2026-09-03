import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/**
 * rotation is itself a version-bumping write, so it carries the
 * same OCC predicate as `UpdateWebhookRequest.expectedVersion` — the
 * controller folds `If-Match` over this exactly like the PATCH route.
 */
export class RotateWebhookSecretRequest {
  @ApiProperty({
    description:
      'Current version of the row (from the prior GET, e.g. via the `ETag` header). Rotation fails with `412 Precondition Failed` if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
