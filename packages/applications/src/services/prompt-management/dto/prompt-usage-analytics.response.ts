import { ApiProperty } from '@nestjs/swagger';

/**
 * Usage-analytics aggregates for `PromptUsageRecord`, grouped by
 * department, doctor, and UTC day. Tenant-scoped; an optional
 * `promptTemplateId` query narrows the aggregation to a single template.
 */
export class PromptUsageByDepartment {
  @ApiProperty({ description: 'Department ID (null = unassigned)', nullable: true })
  departmentId: string | null;

  @ApiProperty({ description: 'Usage count' })
  count: number;
}

export class PromptUsageByDoctor {
  @ApiProperty({ description: 'Doctor ID (null = unattributed)', nullable: true })
  doctorId: string | null;

  @ApiProperty({ description: 'Usage count' })
  count: number;
}

export class PromptUsageByDay {
  @ApiProperty({ description: 'UTC day bucket (YYYY-MM-DD)', example: '2026-06-01' })
  day: string;

  @ApiProperty({ description: 'Usage count' })
  count: number;
}

export class PromptUsageAnalyticsResponse {
  @ApiProperty({ description: 'Total usage records across all buckets' })
  totalUsages: number;

  @ApiProperty({ description: 'Counts grouped by department', type: [PromptUsageByDepartment] })
  byDepartment: PromptUsageByDepartment[];

  @ApiProperty({ description: 'Counts grouped by doctor', type: [PromptUsageByDoctor] })
  byDoctor: PromptUsageByDoctor[];

  @ApiProperty({ description: 'Counts grouped by UTC day', type: [PromptUsageByDay] })
  byDay: PromptUsageByDay[];
}
