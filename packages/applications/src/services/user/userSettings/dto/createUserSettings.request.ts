import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { BaseRequest } from '../../../../common';
import { ValueType } from '@arcaai/domains';

export class CreateUserSettingsRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the setting' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Key of the setting' })
  @IsString()
  key!: string;

  @ApiProperty({ description: 'Value of the setting' })
  @IsString()
  value!: string;

  @ApiProperty({
    description: 'Data type of the setting value',
    enum: ValueType,
  })
  @IsEnum(ValueType)
  dataType!: ValueType;

  @ApiProperty({ description: 'Namespace of the setting', required: false })
  @IsString()
  @IsOptional()
  namespace?: string;

  @ApiProperty({ description: 'ID of the user' })
  @IsString()
  userId!: string;
}
