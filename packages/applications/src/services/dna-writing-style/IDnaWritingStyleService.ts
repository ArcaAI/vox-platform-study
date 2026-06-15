import {
  DnaReportResponse,
  DnaVersionResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  DnaDashboardResponse,
  DnaSettingsResponse,
  UpdateDnaSettingsRequest,
} from './dto';

export interface DnaJobResponse {
  jobId: string;
  status: string;
}

/** TASK-331 doc-02 F6 — filters for the paginated admin report list. */
export interface ListDnaReportsFilters {
  /** Global admins only: scope to a tenant. Ignored for tenant admins. */
  tenantId?: string;
  doctorId?: string;
  includeDisabled?: boolean;
  page?: number;
  limit?: number;
}

/** TASK-331 doc-02 F6 — paginated admin report list envelope. */
export interface PaginatedDnaReports {
  data: DnaReportResponse[];
  count: number;
  page: number;
  limit: number;
}

export abstract class IDnaWritingStyleService {
  abstract generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse>;
  abstract getDnaReport(doctorId: string): Promise<DnaReportResponse | null>;
  /**
   * TASK-356 Phase 6 (S3) — read the caller doctor's DNA on/off settings
   * (effective = tenant AND doctor, plus the tenant gate + DOCTOR-row OCC
   * version). Storage is the Phase-5 DOCTOR-scope `PipelinePolicy.dnaStyleEnabled`.
   */
  abstract getDnaSettings(doctorId: string): Promise<DnaSettingsResponse>;
  /**
   * TASK-356 Phase 6 (S3) — write the caller doctor's DNA on/off toggle
   * (`enabled: null` clears the override). Broadcasts a `ResourceUpdated`
   * SysEvent; the DNA processor honours opt-out on the next batch.
   */
  abstract setDnaEnabled(doctorId: string, dto: UpdateDnaSettingsRequest): Promise<DnaSettingsResponse>;
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
   * TASK-331 doc-02 F6 — repository-level paginated admin list. Tenant scope is
   * resolved identically to {@link getDashboard}: a global admin may pass
   * `tenantId` (or omit it for an all-tenants view); a tenant admin is pinned to
   * their CLS tenant and any supplied `tenantId` is ignored.
   */
  abstract listReportsPaginated(filters?: ListDnaReportsFilters): Promise<PaginatedDnaReports>;
  /**
   * TASK-328 A5 — Aggregate dashboard. A global admin (SUPER_ADMIN/GLOBAL_ADMIN)
   * may pass `tenantId` to scope to a tenant (or omit it for an all-tenants
   * view); a tenant admin is pinned to their CLS tenant and the argument is
   * ignored.
   */
  abstract getDashboard(tenantId?: string): Promise<DnaDashboardResponse>;
}
