import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class PromptTemplateResponse {
  @ApiProperty({ description: 'Template ID' })
  id: string;

  @ApiProperty({ description: 'Template name' })
  name: string;

  @ApiPropertyOptional({ description: 'Template description' })
  description?: string;

  @ApiProperty({ description: 'Prompt content text' })
  content: string;

  @ApiProperty({ description: 'Template category' })
  category: string;

  @ApiPropertyOptional({ description: 'Template variable definitions' })
  variables?: Record<string, unknown>;

  @ApiProperty({ description: 'Current version number' })
  currentVersionNumber: number;

  @ApiPropertyOptional({ description: 'Department ID' })
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  tags?: string[];

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;
}
