import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { BaseRequest } from '../../../common';

/**
 * Body for `PUT /admin/tenants/:id/tags`. Replaces the
 * tenant's full tag set (idempotent set-semantics, not append). Non-OCC.
 */
export class SetTenantTagsRequest extends BaseRequest {
  @ApiProperty({ description: 'Full replacement set of tenant tags', type: [String], example: ['priority', 'pilot'] })
  @IsArray()
  @IsString({ each: true })
  tags!: string[];
}
