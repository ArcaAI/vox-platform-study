import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common/dto/paginated.response';

/**
 * One agent/prompt run row for the tenant-detail "Agent Jobs"
 * surface. A `PromptUsageRecord` is written whenever a prompt template is
 * resolved for a consultation (explore/summary generation), so the raw rows
 * ARE the tenant's agent-run history. Read-only; IDs are returned as-is and
 * resolved to display names client-side from already-loaded collections.
 */
export class PromptUsageRecordResponse {
  @ApiProperty({ description: 'Usage record ID' })
  id: string;

  @ApiPropertyOptional({ description: 'Prompt template ID that ran', nullable: true })
  promptTemplateId?: string | null;

  @ApiPropertyOptional({ description: 'Template version number at run time', nullable: true })
  promptVersionNumber?: number | null;

  @ApiPropertyOptional({ description: 'Consultation the run belonged to', nullable: true })
  consultationId?: string | null;

  @ApiPropertyOptional({ description: 'Doctor who triggered the run', nullable: true })
  doctorId?: string | null;

  @ApiPropertyOptional({ description: 'Department scope of the run', nullable: true })
  departmentId?: string | null;

  @ApiProperty({ description: 'Run timestamp (ISO)' })
  createdAt: string;
}

export class PaginatedPromptUsageRecordResponse extends PaginatedResponse<PromptUsageRecordResponse> {
  @ApiProperty({ type: [PromptUsageRecordResponse] })
  declare readonly data: readonly PromptUsageRecordResponse[];
}
