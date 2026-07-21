import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { ApiKeyResponse } from './apikey.response';

export class PaginatedApiKeyResponse extends PaginatedResponse<ApiKeyResponse> {
  @ApiProperty({ type: [ApiKeyResponse] })
  readonly data!: ApiKeyResponse[];

  constructor(props: { page: number; limit: number; count: number; data: ApiKeyResponse[] }) {
    super(props);
  }
}
