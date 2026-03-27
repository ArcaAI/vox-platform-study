import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDepartmentRequest {
  @ApiPropertyOptional({ description: 'Department code (unique per tenant)', example: 'CARD' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Department description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
  @IsOptional()
  @IsString()
  parentDepartmentId?: string;
}
