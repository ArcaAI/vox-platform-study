import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';
import { ValueType } from '@arcaai/domains';

export class UserSettingsResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the setting' })
  name!: string;

  @ApiProperty({ description: 'Key of the setting' })
  key!: string;

  @ApiProperty({ description: 'Value of the setting' })
  value!: string;

  @ApiProperty({
    description: 'Data type of the setting value',
    enum: ValueType,
  })
  dataType!: ValueType;

  @ApiProperty({ description: 'Namespace of the setting', required: false })
  namespace?: string;

  @ApiProperty({ description: 'ID of the user' })
  userId!: string;

  constructor(init: UserSettingsResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.key = init.key;
    this.value = init.value;
    this.dataType = init.dataType;
    this.namespace = init.namespace;
    this.userId = init.userId;
  }
}
