import { IsString, IsOptional, IsObject, MaxLength, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWorkflowTestFixtureRequest {
  @ApiPropertyOptional({ description: 'Fixture name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Fixture description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Palette this fixture is scoped to' })
  @IsOptional()
  @IsString()
  paletteId?: string;

  @ApiPropertyOptional({ description: 'WorkflowDefinition id this fixture is scoped to' })
  @IsOptional()
  @IsString()
  workflowDefinitionId?: string;

  @ApiPropertyOptional({
    description:
      'Synthetic test input. SYNTHETIC ONLY — do not paste real or realistic patient data. Stored encrypted with Vault Transit; supplying it re-encrypts the payload.',
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  /**
   * Optimistic-concurrency token, same contract as `UpdateDepartmentRequest.expectedVersion`
   * (rule 05 §Optimistic Concurrency). The `ETagInterceptor` + `@RequiresIfMatch()` route also
   * accepts the canonical `If-Match` header; the controller folds it over this field.
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
