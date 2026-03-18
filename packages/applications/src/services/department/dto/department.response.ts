import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class DepartmentResponse {
    @ApiProperty({ description: 'Department ID' })
    id: string;

    @ApiPropertyOptional({ description: 'Department code', example: 'CARD' })
    code?: string;

    @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
    name?: string;

    @ApiPropertyOptional({ description: 'Department description' })
    description?: string;

    @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
    parentDepartmentId?: string;

    @ApiProperty({ description: 'Whether this is a root department (no parent)' })
    isRootDepartment: boolean;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;

    @ApiProperty({ description: 'Last update timestamp' })
    updatedAt: string;

    @ApiPropertyOptional({ description: 'Default summary template for this department' })
    defaultSummaryTemplate?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
    preSummaryPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for new/referral patients' })
    newPatientPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for revisit patients' })
    revisitPromptId?: string;

    @ApiPropertyOptional({ description: 'Department prompt configuration' })
    promptConfig?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
    resourceStatus?: ResourceStatusType;
}
