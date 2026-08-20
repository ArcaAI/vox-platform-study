import { IsString, IsOptional, IsObject, MaxLength, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowTestFixtureRequest {
  @ApiProperty({ description: 'Fixture name', example: 'Two-speaker follow-up visit' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: 'Fixture description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Palette this fixture is scoped to (code-owned vocabulary, no enum)' })
  @IsOptional()
  @IsString()
  paletteId?: string;

  @ApiPropertyOptional({ description: 'WorkflowDefinition id this fixture is scoped to. Omit for a tenant-wide fixture.' })
  @IsOptional()
  @IsString()
  workflowDefinitionId?: string;

  @ApiProperty({
    description:
      'Synthetic test input. SYNTHETIC ONLY — do not paste real or realistic patient data. Stored encrypted with Vault Transit (README §6/R4, RESOLVED): the plaintext column was dropped, so only ciphertext is persisted.',
  })
  @IsObject()
  input!: Record<string, unknown>;
}
