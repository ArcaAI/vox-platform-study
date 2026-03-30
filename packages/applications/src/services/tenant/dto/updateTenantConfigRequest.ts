import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../common';
import { EntityId } from '@arcaai/domains';
import { EntityIdProperty } from '../../../decorators';

export class UpdateTenantConfigRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the configuration' })
  @EntityIdProperty()
  id!: EntityId;

  @ApiProperty({ description: 'Description of the configuration', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Value for the configuration' })
  @IsString()
  value!: string;
}
