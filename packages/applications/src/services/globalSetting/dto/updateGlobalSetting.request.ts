import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ValueType } from '@arcaai/domains';

export class UpdateGlobalSettingRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the global setting', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Description of the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Unique key for the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  key?: string;

  @ApiProperty({
    description: 'Value of the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  value?: string;

  @ApiProperty({
    description: 'Data type of the global setting',
    enum: ValueType,
    required: false,
  })
  @IsEnum(ValueType)
  @IsOptional()
  dataType?: ValueType;

  @ApiProperty({
    description: 'Namespace for the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  namespace?: string;
}
