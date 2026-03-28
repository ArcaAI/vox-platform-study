import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ValueType } from '@arcaai/domains';

export class GlobalSettingResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the global setting' })
  name!: string;

  @ApiProperty({
    description: 'Description of the global setting',
    required: false,
  })
  description?: string;

  @ApiProperty({ description: 'Unique key for the global setting' })
  key!: string;

  @ApiProperty({ description: 'Value of the global setting' })
  value!: string;

  @ApiProperty({
    description: 'Data type of the global setting',
    enum: ValueType,
  })
  dataType!: ValueType;

  @ApiProperty({
    description: 'Namespace for the global setting',
    required: false,
  })
  namespace?: string;

  constructor(init: GlobalSettingResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.description = init.description;
    this.key = init.key;
    this.value = init.value;
    this.dataType = init.dataType;
    this.namespace = init.namespace;
  }
}
