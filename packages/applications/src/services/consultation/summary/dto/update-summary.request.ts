import { IsString, IsOptional, IsIn, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSummaryRequest {
  @ApiPropertyOptional({ description: 'Updated summary content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  @IsOptional()
  @IsString()
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Summary of what changed' })
  @IsOptional()
  @IsString()
  changeSummary?: string;

  @ApiPropertyOptional({ description: 'Source of the change', enum: ['doctor_edit', 'ai_regeneration', 'system'] })
  @IsOptional()
  @IsString()
  @IsIn(['doctor_edit', 'ai_regeneration', 'system'])
  changeSource?: string;

  /**
   * optimistic-concurrency token. Mirrors
   * `UpdateDepartmentRequest.expectedVersion` verbatim: required. The client
   * echoes the `version` it read from a prior GET; the service runs a
   * Compare-And-Set (`contextItemRepository.updateWithVersion`) and fails with
   * `OptimisticConcurrencyException` -> HTTP 412 on drift. On a
   * `@RequiresIfMatch()` route the controller folds the `If-Match` header
   * value over this field when both are present.
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /**
   * TASK-972 Lane 1 — the clinician this edit belongs to.
   *
   * REQUIRED for a machine credential (a machine is never a clinician) and refused for a human
   * who is not a tenant/super administrator. See
   * `consultation/summary/clinician-attribution.ts` for the whole rule; the field is declared
   * here because the global pipe runs `forbidNonWhitelisted`, so an undeclared field is rejected
   * before any service sees it.
   */
  @ApiPropertyOptional({
    description:
      'The clinician this edit is attributed to. Required for a machine credential (API key / service account); a human may name ' +
      'another clinician only while holding SUPER_ADMIN or TENANT_ADMIN.',
  })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;
}
