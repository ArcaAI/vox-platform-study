import { ApiProperty } from '@nestjs/swagger';
import { ContextItemResponse } from './context-item.response';

/**
 * Paginated Context Item Response
 *
 * Wraps a page of context items with total count and pagination metadata.
 * Consistent with the project's PaginatedConsultationResponse pattern.
 */
export class PaginatedContextItemResponse {
  @ApiProperty({ type: [ContextItemResponse], description: 'Page of context items' })
  data: ContextItemResponse[];

  @ApiProperty({ description: 'Total number of matching items', example: 42 })
  count: number;

  @ApiProperty({ description: 'Current page number (1-based)', example: 1 })
  page: number;

  @ApiProperty({ description: 'Items per page', example: 50 })
  limit: number;
}
