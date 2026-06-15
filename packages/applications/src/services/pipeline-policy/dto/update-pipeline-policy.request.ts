import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * PATCH body for the admin realtime-pipeline policy routes (TASK-356 Phase 5).
 * Every toggle is OPTIONAL with three-valued semantics:
 *  - OMIT a field  → leave it unchanged.
 *  - `true`/`false` → pin the toggle at this scope.
 *  - `null`        → explicitly CLEAR the pin (revert to inheriting from the next
 *                    cascade tier up).
 *
 * `dnaStyleEnabled` is intentionally ABSENT — it is doctor-scope storage written
 * by the Phase 6 doctor self-service surface, not by this admin (tenant/department)
 * write surface. `expectedVersion` is the OCC token (folded from the `If-Match`
 * header by the controller; body fallback for service-to-service callers).
 */
export class UpdatePipelinePolicyRequest {
  @ApiPropertyOptional({ description: 'Auto-summary toggle (null = clear/inherit).', nullable: true })
  @IsOptional()
  @IsBoolean()
  autoSummaryEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Auto-NER toggle (null = clear/inherit).', nullable: true })
  @IsOptional()
  @IsBoolean()
  autoNerEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Harness-vs-legacy routing toggle (null = clear/inherit). Max scope: department.', nullable: true })
  @IsOptional()
  @IsBoolean()
  harnessEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Free-text reason for the edit, recorded on the WORM change row.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Optimistic-concurrency token. On a `@RequiresIfMatch()` route the controller
   * folds the RFC 7232 `If-Match` header over this field. Version drift on an
   * existing row raises `412 Precondition Failed`.
   */
  @ApiPropertyOptional({ description: 'Current row version (from the prior GET). PATCH fails 412 if it drifted.', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
