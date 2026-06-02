import { DnaReportResponse, DnaVersionResponse, GenerateDnaReportRequest, UpdateDnaReportRequest, DnaDashboardResponse } from './dto';

export interface DnaJobResponse {
  jobId: string;
  status: string;
}

export abstract class IDnaWritingStyleService {
  abstract generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse>;
  abstract getDnaReport(doctorId: string): Promise<DnaReportResponse | null>;
  abstract updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse>;
  /**
   * TASK-329 P5 — Promote a historical report to the caller's active/default
   * (`isLatest`) report, demoting the previous default. Tenant + owner scoped.
   */
  abstract setDefaultReport(reportId: string): Promise<DnaReportResponse>;
  abstract getVersions(reportId: string): Promise<DnaVersionResponse[]>;
  abstract getVersionsForDoctor(reportId: string, doctorId: string): Promise<DnaVersionResponse[]>;
  abstract listReports(filters?: { doctorId?: string; includeDisabled?: boolean }): Promise<DnaReportResponse[]>;
  /**
   * TASK-328 A5 — Aggregate dashboard. A global admin (SUPER_ADMIN/GLOBAL_ADMIN)
   * may pass `tenantId` to scope to a tenant (or omit it for an all-tenants
   * view); a tenant admin is pinned to their CLS tenant and the argument is
   * ignored.
   */
  abstract getDashboard(tenantId?: string): Promise<DnaDashboardResponse>;
}
