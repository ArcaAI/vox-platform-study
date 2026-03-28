import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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
}
