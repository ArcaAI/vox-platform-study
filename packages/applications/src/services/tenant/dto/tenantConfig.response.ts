import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { EntityId, ValueType } from '@arcaai/domains';

export class TenantConfigResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the configuration' })
  name!: string;

  @ApiProperty({ description: 'Description of the configuration', required: false })
  description?: string;

  @ApiProperty({ description: 'Unique key for the configuration' })
  key!: string;

  @ApiProperty({ description: 'Default value for the configuration', required: false })
  defaultValue?: string;

  @ApiProperty({ description: 'Value for the configuration' })
  value!: string;

  @ApiProperty({ description: 'Data type of the configuration value', enum: ValueType })
  dataType!: ValueType;

  @ApiProperty({ description: 'Namespace for the configuration', required: false })
  namespace?: string;

  @ApiProperty({ description: 'ID of the tenant this configuration belongs to' })
  tenantId!: EntityId;

  @ApiProperty({ description: 'Code/Key of the tenant this configuration belongs to' })
  tenantCode!: string;

  constructor(init: TenantConfigResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.description = init.description;
    this.key = init.key;
    this.defaultValue = init.defaultValue;
    this.value = init.value;
    this.dataType = init.dataType;
    this.namespace = init.namespace;
    this.tenantId = init.tenantId;
    this.tenantCode = init.tenantCode;
  }
}
