import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Update a user-department assignment (TASK-328 A1).
 *
 * Currently only the `isPrimary` flag is mutable. Optimistic concurrency is
 * enforced: the client echoes the `version` it read via `If-Match` (folded
 * onto `expectedVersion` by the controller) and the service runs a
 * Compare-And-Set that fails with 412 on drift.
 */
export class UpdateUserDepartmentRequest {
  @ApiPropertyOptional({ description: "Whether this is the user's primary department" })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
