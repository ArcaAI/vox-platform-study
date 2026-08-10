import {
  DnaReportResponse,
  DnaVersionResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  DnaDashboardResponse,
  DnaSettingsResponse,
  UpdateDnaSettingsRequest,
} from './dto';
import { RedactionRuleSet } from './redaction-rules';

export interface DnaJobResponse {
  jobId: string;
  status: string;
}

/** Filters for the paginated admin report list. */
export interface ListDnaReportsFilters {
  /** Global admins only: scope to a tenant. Ignored for tenant admins. */
  tenantId?: string;
  doctorId?: string;
  includeDisabled?: boolean;
  page?: number;
  limit?: number;
}

/** Paginated admin report list envelope. */
export interface PaginatedDnaReports {
  data: DnaReportResponse[];
  count: number;
  page: number;
  limit: number;
}

export abstract class IDnaWritingStyleService {
  abstract generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse>;
  abstract getDnaReport(doctorId: string): Promise<DnaReportResponse | null>;
  abstract getRedactionRules(doctorId: string): Promise<RedactionRuleSet>;
  /**
   * TASK-599 — the doctor's DECRYPTED DNA writing-style text, or `null` when DNA
   * style is disabled (tenant AND doctor gate), the doctor has no report/style,
   * or the secrets backend is unwired. Reused by the v1-compat SMR path to inject
   * the doctor's style into the summary/pre-summary prompt. Never throws on an
   * absent/disabled style — DNA is additive.
   *
   * `explicitTenantId` (TASK-651) supplies the tenant for callers whose CLS
   * `tenantId` is empty — notably the API-key-authenticated v1-compat surface,
   * where only the JWT strategy populates CLS. Omit it and the CLS value is used
   * as before. Tenant membership of `doctorId` is asserted either way.
   */
  abstract getEffectiveStyleText(doctorId: string, explicitTenantId?: string): Promise<string | null>;
  /**
   * Read the caller doctor's DNA on/off settings
   * (effective = tenant AND doctor, plus the tenant gate + DOCTOR-row OCC
   * version). Storage is the Phase-5 DOCTOR-scope `PipelinePolicy.dnaStyleEnabled`.
   */
  abstract getDnaSettings(doctorId: string): Promise<DnaSettingsResponse>;
  /**
   * Write the caller doctor's DNA on/off toggle
   * (`enabled: null` clears the override). Broadcasts a `ResourceUpdated`
   * SysEvent; the DNA processor honours opt-out on the next batch.
   */
  abstract setDnaEnabled(doctorId: string, dto: UpdateDnaSettingsRequest): Promise<DnaSettingsResponse>;
  abstract updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse>;
  /**
   * Promote a historical report to the caller's active/default
   * (`isLatest`) report, demoting the previous default. Tenant + owner scoped.
   */
  abstract setDefaultReport(reportId: string): Promise<DnaReportResponse>;
  abstract getVersions(reportId: string): Promise<DnaVersionResponse[]>;
  abstract getVersionsForDoctor(reportId: string, doctorId: string): Promise<DnaVersionResponse[]>;
  abstract listReports(filters?: { doctorId?: string; includeDisabled?: boolean }): Promise<DnaReportResponse[]>;
  /**
   * Repository-level paginated admin list. Tenant scope is
   * resolved identically to {@link getDashboard}: a global admin may pass
   * `tenantId` (or omit it for an all-tenants view); a tenant admin is pinned to
   * their CLS tenant and any supplied `tenantId` is ignored.
   */
  abstract listReportsPaginated(filters?: ListDnaReportsFilters): Promise<PaginatedDnaReports>;
  /**
   * Aggregate dashboard. A global admin (GLOBAL_ADMIN)
   * may pass `tenantId` to scope to a tenant (or omit it for an all-tenants
   * view); a tenant admin is pinned to their CLS tenant and the argument is
   * ignored.
   */
  abstract getDashboard(tenantId?: string): Promise<DnaDashboardResponse>;
}
