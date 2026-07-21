import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { GlobalSettingResponse } from '.';

export class PaginatedGlobalSettingResponse extends PaginatedResponse<GlobalSettingResponse> {
  @ApiProperty({ type: [GlobalSettingResponse] })
  override readonly data!: readonly GlobalSettingResponse[];
}
