import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';

export class TenantResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the tenant' })
  name!: string;

  @ApiProperty({ description: 'Unique key for the tenant' })
  key!: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  description?: string;

  constructor(init: TenantResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.key = init.key;
    this.description = init.description;
  }
}
