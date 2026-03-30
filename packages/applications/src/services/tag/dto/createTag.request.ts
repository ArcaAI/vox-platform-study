import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../common';

export class CreateTagRequest extends BaseRequest {
  @ApiProperty({ description: 'Resource type name', required: false })
  @IsString()
  @IsOptional()
  resourceTypeName?: string;

  @ApiProperty({ description: 'Resource ID', required: false })
  @IsString()
  @IsOptional()
  resourceId?: string;

  @ApiProperty({ description: 'Tag key', required: false })
  @IsString()
  @IsOptional()
  tagKey?: string;

  @ApiProperty({ description: 'Tag value' })
  @IsString()
  tagValue!: string;

  @ApiProperty({ description: 'Description of the tag', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Color code for the tag', required: false })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiProperty({
    description: 'Icon identifier for the tag',
    required: false,
  })
  @IsString()
  @IsOptional()
  icon?: string;
}
