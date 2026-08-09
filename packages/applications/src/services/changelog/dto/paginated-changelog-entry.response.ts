import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { ChangelogEntryResponse } from './changelog-entry.response';

export class PaginatedChangelogEntryResponse extends PaginatedResponse<ChangelogEntryResponse> {
  @ApiProperty({ type: [ChangelogEntryResponse] })
  override readonly data!: readonly ChangelogEntryResponse[];
}
