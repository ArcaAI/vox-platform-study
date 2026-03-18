import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignDepartmentPromptRequest {
    @ApiProperty({ description: 'Department ID to assign prompts to' })
    @IsString()
    departmentId: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for new patients' })
    @IsOptional()
    @IsString()
    newPatientPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for revisits' })
    @IsOptional()
    @IsString()
    revisitPromptId?: string;
}
