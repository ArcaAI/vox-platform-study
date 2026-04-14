import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class EnrollBodyDto {
  @ApiProperty({ description: 'Optional label for this voice profile', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  label?: string;
}
