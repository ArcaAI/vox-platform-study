import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PromptVersionResponse {
  @ApiProperty({ description: 'Version record ID' })
  id: string;

  @ApiProperty({ description: 'Parent template ID' })
  promptTemplateId: string;

  @ApiProperty({ description: 'Version number' })
  versionNumber: number;

  @ApiProperty({ description: 'Prompt content at this version' })
  content: string;

  @ApiPropertyOptional({ description: 'Variables at this version' })
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Who made the change' })
  changedBy?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;
}
