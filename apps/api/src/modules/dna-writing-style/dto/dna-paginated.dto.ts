import { ApiProperty } from '@nestjs/swagger';
import { DnaReportResponse } from '@arcaai/applications';

export class PaginatedDnaReportResponse {
  @ApiProperty({ description: 'DNA reports', type: [DnaReportResponse] })
  data!: DnaReportResponse[];

  @ApiProperty({ description: 'Total count' })
  count!: number;

  @ApiProperty({ description: 'Page size limit' })
  limit!: number;

  @ApiProperty({ description: 'Current page number' })
  page!: number;
}
