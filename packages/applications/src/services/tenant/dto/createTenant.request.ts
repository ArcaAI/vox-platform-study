import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../common';

export class CreateTenantRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the tenant' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Unique key for the tenant' })
  @IsString()
  key!: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  @IsString()
  @IsOptional()
  description?: string;
}
