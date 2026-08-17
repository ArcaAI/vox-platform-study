import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DNA aggregate dashboard DTOs.
 *
 * Returned by `GET /admin/dna-writing-styles/dashboard`. All counts are
 * tenant-scoped by the service (a super admin may target a specific tenant
 * via `?tenantId=`, a tenant admin is pinned to their CLS tenant).
 */
export class DnaDashboardDailyCount {
  @ApiProperty({ description: 'Day bucket (YYYY-MM-DD, UTC)' })
  date: string;

  @ApiProperty({ description: 'Usage records created on this day' })
  count: number;
}

export class DnaDashboardUsageEntry {
  @ApiProperty({ description: 'Usage record ID' })
  id: string;

  @ApiProperty({ description: 'Doctor ID' })
  doctorId: string;

  @ApiProperty({ description: 'DNA report ID the usage referenced' })
  dnaReportId: string;

  @ApiPropertyOptional({ description: 'DNA report version applied' })
  dnaVersionNumber?: number;

  @ApiPropertyOptional({ description: 'Consultation the style was used in' })
  consultationId?: string;

  @ApiProperty({ description: 'When the usage occurred (ISO-8601)' })
  createdAt: string;
}

export class DnaDashboardRecentActivity {
  @ApiProperty({ description: 'Per-day usage counts over the window (oldest first)', type: [DnaDashboardDailyCount] })
  dailyCounts: DnaDashboardDailyCount[];

  @ApiProperty({ description: 'A few of the most recent usage entries (newest first)', type: [DnaDashboardUsageEntry] })
  latest: DnaDashboardUsageEntry[];

  @ApiProperty({ description: 'Total usage records within the window' })
  total: number;

  @ApiProperty({ description: 'Window length in days the activity covers' })
  windowDays: number;
}

export class DnaDashboardResponse {
  @ApiProperty({ description: 'Count of distinct doctors that have a latest report' })
  usersWithStyle: number;

  @ApiProperty({ description: 'Average current version number across latest reports' })
  avgVersions: number;

  @ApiProperty({ description: 'Recent DNA usage activity aggregated from DnaUsageRecord', type: DnaDashboardRecentActivity })
  recentActivity: DnaDashboardRecentActivity;
}
