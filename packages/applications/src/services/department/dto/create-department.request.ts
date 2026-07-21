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

  // CC-04 — the admin create modal collects a default summary
  // template. The field must be whitelisted here or the global
  // `forbidNonWhitelisted` ValidationPipe rejects the request (400) before it
  // reaches the service. `UpdateDepartmentRequest` already exposes it; this
  // brings create to parity so a template typed at create-time is not dropped.
  @ApiPropertyOptional({ description: 'Default summary template for the department' })
  @IsOptional()
  @IsString()
  defaultSummaryTemplate?: string;
}
