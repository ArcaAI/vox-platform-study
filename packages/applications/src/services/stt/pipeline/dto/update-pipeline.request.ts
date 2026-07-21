import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class UpdatePipelineRequest {
  @ApiPropertyOptional({
    description: 'Pipeline name',
    example: 'Whisper Large V3 Medical Updated',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL-friendly unique identifier',
    example: 'whisper-large-v3-medical',
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({
    description: 'Pipeline description',
    example: 'Updated description for medical transcription pipeline',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Pipeline configuration in YAML format',
  })
  @IsString()
  @IsOptional()
  configYaml?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
    example: ['medical', 'high-accuracy', 'production'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  // Captured on the AsrPipelineVersion snapshot when the
  // YAML config changes (audit trail for "why this version exists").
  @ApiPropertyOptional({
    description: 'Reason for the change; recorded on the version snapshot when configYaml changes.',
    example: 'Switched ASR model to whisper-large-v3',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  changeReason?: string;

  // Required CAS predicate (echoed from
  // the prior GET). The controller folds the `If-Match` header over
  // this when both are present; missing both yields `428 Precondition
  // Required` (on `@RequiresIfMatch()` routes).
  @ApiProperty({
    description:
      'Current version of the row (from the prior GET, e.g. via the `ETag` header). The PATCH fails with `412 Precondition Failed` if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
