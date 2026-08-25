import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { ConsentGrantResponse } from './consent-grant.response';

export class PaginatedConsentGrantResponse extends PaginatedResponse<ConsentGrantResponse> {
  @ApiProperty({ type: [ConsentGrantResponse] })
  declare readonly data: readonly ConsentGrantResponse[];

  constructor(props: PaginatedConsentGrantResponse) {
    super(props);
  }
}
