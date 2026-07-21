import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { PermissionResponse } from '.';

export class PaginatedPermissionResponse extends PaginatedResponse<PermissionResponse> {
  @ApiProperty({ type: [PermissionResponse] })
  override readonly data!: readonly PermissionResponse[];
}
