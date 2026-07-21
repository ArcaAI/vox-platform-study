import { IsString, IsOptional, IsObject, IsInt, MaxLength, Min, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdateDepartmentRequest {
  @ApiPropertyOptional({ description: 'Department code (unique per tenant)', example: 'CARD' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Department description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
  @IsOptional()
  @IsString()
  parentDepartmentId?: string | null;

  @ApiPropertyOptional({ description: 'Default summary template' })
  @IsOptional()
  @IsString()
  defaultSummaryTemplate?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
  @IsOptional()
  @IsString()
  preSummaryPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for new patients' })
  @IsOptional()
  @IsString()
  newPatientPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for revisit patients' })
  @IsOptional()
  @IsString()
  revisitPromptId?: string;

  @ApiPropertyOptional({ description: 'Department prompt configuration' })
  @IsOptional()
  @IsObject()
  promptConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  /**
   * Optimistic-concurrency token.
   *
   * Required. The client must read the row first, then echo back the
   * `version` it observed. The service issues a Compare-And-Set
   * (`departmentRepository.updateWithVersion`) and fails with
   * `OptimisticConcurrencyException` → HTTP 412 Precondition Failed
   * if `_version` has drifted under the client between read and write.
   *
   * The `ETagInterceptor` + `@RequiresIfMatch()` exposes the
   * canonical RFC 7232 `If-Match` mechanism; the body field stays as
   * the documented service-to-service fallback (the controller folds
   * the header value over this when both are present).
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
