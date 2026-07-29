import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
export class StopSessionRequest {
  @ApiProperty({ description: 'Session identifier' })
  @IsString()
  session_id: string;

  @ApiPropertyOptional({ description: 'Audio sample rate in Hz' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sample_rate?: number;

  @ApiPropertyOptional({ description: 'Number of audio channels' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  channels?: number;

  @ApiPropertyOptional({ description: 'Audio bit depth' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  bit_depth?: number;
}
