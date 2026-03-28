import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdateDnaReportRequest {
  @ApiPropertyOptional({ description: 'Updated report data (JSON)' })
  @IsOptional()
  reportData?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Updated style text' })
  @IsOptional()
  @IsString()
  styleText?: string;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  @IsOptional()
  @IsString()
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;
}
