import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import {
  DnaWritingStyleReportRepository,
  DnaWritingStyleVersionRepository,
  DnaUsageRecordRepository,
  DnaWritingStyleReportEntityMapper,
  DnaWritingStyleVersionFactory,
  JobQueue,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  CoreDatabaseService,
} from '@arcaai/domains';
import { IDnaWritingStyleService, DnaJobResponse, ListDnaReportsFilters, PaginatedDnaReports } from './IDnaWritingStyleService';
import {
  DnaReportResponse,
  DnaVersionResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  DnaDashboardResponse,
  DnaSettingsResponse,
  UpdateDnaSettingsRequest,
} from './dto';
import { DnaWritingStyleDtoMapper } from './dna-writing-style.dto.mapper';
import { RedactionRuleSet, validateRedactionRuleSet } from './redaction-rules';
// The per-doctor DNA toggle is stored on the Phase-5
// DOCTOR-scope `PipelinePolicy.dnaStyleEnabled` column; this service is the
// doctor self-service surface that writes/reads it via PipelinePolicyService.
import { PipelinePolicyService } from '../pipeline-policy';
import { SecretsService } from '../baseServices/_meta/secrets';
import { BaseService, encryptPhiFields } from '../../common';
import { assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

export interface GenerateDnaReportJobPayload {
  jobId: string;
  doctorId: string;
  tenantId: string;
  userId: string;
  textSamples?: string[];
  // Historical source IDs the generation was seeded from.
  sourceIds?: string[];
}

export interface DnaReportJobResult {
  reportId: string;
  reportData: Record<string, unknown>;
  styleText: string;
}

@Injectable()
export class DnaWritingStyleService extends BaseService implements IDnaWritingStyleService {
  constructor(
    private readonly dnaReportRepository: DnaWritingStyleReportRepository,
    private readonly dnaVersionRepository: DnaWritingStyleVersionRepository,
    // Source for the aggregate dashboard's recent-activity feed.
    private readonly dnaUsageRecordRepository: DnaUsageRecordRepository,
    // (audit C-9) — needed by `assertUserBelongsToTenant` to
    // verify a `doctorId` is a member of the caller's tenant before any
    // DNA-style operation runs against PHI-derived artifacts.
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    // Membership is role + department; the guard needs the
    // department join table and the User table (service-account exemption).
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly userRepository: UserRepository,
    @InjectQueue(JobQueue.GenerateDnaReport) private readonly dnaQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `baseClient.$transaction(callback)` is the canonical Prisma-7
    // atomic idiom in this codebase (see TenantService /
    // PromptManagementService). Required so the version-history insert and the
    // OCC compare-and-set commit (or roll back) together.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // DOCTOR-scope DNA toggle write/read. Optional +
    // trailing so existing positional unit fixtures keep their arity; production
    // DI supplies it via PipelinePolicyServiceModule.
    @Optional() @Inject(PipelinePolicyService) private readonly pipelinePolicyService?: PipelinePolicyService,
    // Optional + trailing (same arity rationale). When wired,
    // manual report edits encrypt reportData/styleText into the ciphertext
    // columns before persisting; left unpersisted when unset (there is no plaintext column).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.DnaWritingStyleReport);
  }

  private readonly logger = new Logger(DnaWritingStyleService.name);

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * (audit C-9) — Queue a DNA-style generation job for a
   * doctor. The doctor must be a role-assigned member of the caller's
   * tenant; GLOBAL_ADMIN does NOT bypass this guard because writing-style
   * artifacts are derived from PHI (transcripts, prior notes), and exposing
   * them across tenants is itself a PHI leak.
   */
  async generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    const userId = this.requestUserId ?? '';
    const jobId = uuidv7();

    const payload: GenerateDnaReportJobPayload = {
      jobId,
      doctorId,
      tenantId,
      userId,
      textSamples: dto.textSamples,
      // Only carry sourceIds when the caller seeded from history;
      // keeps the legacy payload shape unchanged for plain generations.
      ...(dto.sourceIds && dto.sourceIds.length > 0 ? { sourceIds: dto.sourceIds } : {}),
    };

    await this.dnaQueue.add(JobQueue.GenerateDnaReport, payload, {
      jobId,
    });

    // Audit the generation REQUEST. The report row itself is
    // created asynchronously by the worker, but the privileged act of triggering
    // DNA (PHI-derived) generation for a doctor must appear on the audit trail.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: doctorId,
      data: { jobId, doctorId, kind: 'dna-generation-requested' },
    });

    return { jobId, status: 'PENDING' };
  }

  /**
   * (audit C-9) — `doctorId` must belong to the caller's
   * tenant; we surface a `NotFoundException` (no existence leak) for any
   * cross-tenant lookup attempt before the repository is consulted.
   */
  async getDnaReport(doctorId: string): Promise<DnaReportResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
    if (!report) return null;
    // Resolve the doctor's username server-side for display.
    const doctorUsername = await this.resolveDoctorUsername(report.doctorId ?? doctorId);
    return DnaWritingStyleDtoMapper.toReportResponse(report, doctorUsername);
  }

  /**
   * TASK-551 — read the doctor's decrypted DNA redaction/rewrite rule set from
   * their latest report. Same tenant PHI guard as {@link getDnaReport}. Returns
   * an empty rule set when the doctor has no report or no rules configured (never
   * null — the caller always gets a well-formed `{ rules: [] }`).
   */
  async getRedactionRules(doctorId: string): Promise<RedactionRuleSet> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
    if (!report) return { rules: [] };

    // Decrypt the ciphertext column (no-op when the secrets backend is unwired in
    // dev/test). A report predating TASK-551 has no rules ⇒ empty set.
    if (this.secretsService) {
      const { redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
      if (redactionRules) return validateRedactionRuleSet(redactionRules);
    }
    return { rules: [] };
  }

  /**
   * TASK-599 — the doctor's DECRYPTED DNA writing-style text for prompt
   * injection, or `null` when DNA style is not applicable. Composes the same
   * pieces the doctor-facing reads use: the tenant PHI guard, the effective
   * on/off gate (`tenant AND doctor`), the latest report, and ciphertext
   * decryption. Returns `null` — never throws — when the gate is off, there is no
   * report/style, or the secrets backend is unwired, so callers can treat DNA as
   * purely additive.
   */
  async getEffectiveStyleText(doctorId: string): Promise<string | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    // Effective = tenant AND doctor toggle (Phase-5 cascade). Off ⇒ no style.
    const settings = await this.getDnaSettings(doctorId);
    if (!settings.effective) return null;

    const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
    if (!report || !this.secretsService) return null;

    const { styleText } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
    return styleText?.trim() || null;
  }

  /**
   * Resolve a single doctor's `User.username` for display. `User`
   * is a global (non-tenant-scoped) model, so this read is safe for tenant
   * admins. `userRepository.findById` THROWS `DataNotFoundException` when the
   * user is missing (deleted id), so we swallow it and leave the label
   * undefined rather than failing the read.
   */
  private async resolveDoctorUsername(doctorId?: string | null): Promise<string | undefined> {
    if (!doctorId) return undefined;
    try {
      const user = await this.userRepository.findById(doctorId);
      return user?.username ?? undefined;
    } catch {
      // DataNotFoundException — deleted/missing user; leave the label undefined.
      return undefined;
    }
  }

  /**
   * Batch-resolve a page's distinct `doctorId`s to a
   * `id → username` map in ONE query (no N+1), mirroring
   * `AuditLogService.resolveResponsibleUsers`. Returns an empty map (and
   * issues NO query) when there are no ids to resolve.
   */
  private async resolveDoctorUsernames(doctorIds: Array<string | null | undefined>): Promise<Record<string, string>> {
    const ids = Array.from(new Set(doctorIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return {};

    const users = await this.userRepository.findAll({
      where: { id: { in: ids } },
      page: 1,
      limit: ids.length,
    });

    const map: Record<string, string> = {};
    for (const user of users) {
      if (user.username) map[user.id] = user.username;
    }
    return map;
  }

  /**
   * READ the caller doctor's DNA on/off settings. The
   * effective decision is `tenant AND doctor`, resolved through the Phase-5
   * pipeline-policy cascade; the response also carries the tenant gate (so the
   * UI can disable + explain the switch when the tenant disabled DNA) and the
   * DOCTOR-row OCC version. Delegates storage to {@link PipelinePolicyService}.
   */
  async getDnaSettings(doctorId: string): Promise<DnaSettingsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const policy = this.requirePipelinePolicyService();
    const s = await policy.getDnaSettings({ tenantId, doctorId });
    return { doctorToggle: s.doctorToggle, tenantEnabled: s.tenantEnabled, effective: s.effective, version: s.version };
  }

  /**
   * WRITE the caller doctor's DNA on/off toggle onto the
   * DOCTOR-scope `PipelinePolicy.dnaStyleEnabled` column (via
   * {@link PipelinePolicyService}, which keeps the OCC + WORM contract). A null
   * `enabled` clears the override (revert to the implicit opt-in default). A
   * `ResourceUpdated` SysEvent is broadcast so the audit trail records the
   * privileged self-service change. The DNA processor's effective-flag gate then
   * honours an opt-out on the NEXT batch (no synchronous re-learning here).
   */
  async setDnaEnabled(doctorId: string, dto: UpdateDnaSettingsRequest): Promise<DnaSettingsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const policy = this.requirePipelinePolicyService();
    const enabled = dto.enabled ?? null;
    const s = await policy.setDnaStyleForDoctor({
      tenantId,
      doctorId,
      enabled,
      reason: dto.reason ?? null,
      expectedVersion: dto.expectedVersion,
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: doctorId,
      data: { kind: 'dna-settings-updated', doctorId, enabled },
    });

    return { doctorToggle: s.doctorToggle, tenantEnabled: s.tenantEnabled, effective: s.effective, version: s.version };
  }

  /** Guard the optional dependency so a misconfigured DI surfaces a clear 400. */
  private requirePipelinePolicyService(): PipelinePolicyService {
    if (!this.pipelinePolicyService) {
      throw new BadRequestException('DNA settings are not available');
    }
    return this.pipelinePolicyService;
  }

  async updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse> {
    const userId = this.requestUserId;

    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);

    // (audit C-9) — PHI guard. Even an admin caller using
    // `bypassOwnershipCheck` (the per-doctor ownership escape) cannot reach
    // across tenants, and even GLOBAL_ADMIN cannot — the writing style
    // captures the doctor's voice/style derived from PHI.
    this.assertReportInScope(report, reportId);

    if (!options?.bypassOwnershipCheck && report.doctorId !== userId) {
      throw new ForbiddenException("Cannot update another doctor's DNA report");
    }

    // TASK-551 — validate the redaction rule set's JSON shape up front (a 400
    // here beats a fail-closed FLAG mid-consultation). Normalized copy persists.
    const redactionRules = dto.redactionRules !== undefined ? validateRedactionRuleSet(dto.redactionRules) : undefined;

    const hasContentChanges = dto.reportData !== undefined || dto.styleText !== undefined || redactionRules !== undefined;

    // Build the version snapshot (capturing the NEW content) and apply the
    // in-memory entity mutations FIRST; the two DB writes (insert + CAS) then
    // run together inside one transaction below.
    let version: ReturnType<typeof DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion> | null = null;
    if (hasContentChanges) {
      const existingVersions = await this.dnaVersionRepository.findAll({
        filters: { dnaReportId: reportId },
        sort: [{ versionNumber: 'desc' }],
        limit: 1,
      });
      const highestExistingVersion = existingVersions[0]?.versionNumber ?? 0;
      const nextVersionNumber = Math.max(highestExistingVersion, report.currentVersionNumber ?? 0) + 1;

      version = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
        tenantId: report.tenantId,
        dnaReportId: reportId,
        versionNumber: nextVersionNumber,
        reportData: dto.reportData ?? report.reportData,
        styleText: dto.styleText ?? report.styleText,
        // Snapshot the (new or carried-forward) rule set alongside the content.
        redactionRules: (redactionRules ?? report.redactionRules ?? undefined) as Record<string, unknown> | undefined,
        changeReason: dto.changeReason ?? null,
        changedBy: userId ?? null,
      });

      if (dto.reportData !== undefined) report.reportData = dto.reportData;
      if (dto.styleText !== undefined) report.styleText = dto.styleText;
      if (redactionRules !== undefined) report.redactionRules = redactionRules as unknown as Record<string, unknown>;
      report.currentVersionNumber = nextVersionNumber;

      // Re-encrypt the new content into both the version
      // snapshot and the report row before they are persisted in the tx below.
      // Only runs when content actually changed (status-only edits skip it).
      await this.encryptBestEffort('DnaWritingStyleVersion', () => this.dnaVersionRepository.encryptFieldsIntoEntity(version!, this.secretsService!));
      await this.encryptBestEffort('DnaWritingStyleReport', () => this.dnaReportRepository.encryptFieldsIntoEntity(report, this.secretsService!));
    }

    if (dto.resourceStatus !== undefined) {
      await this.updateEntity(report, { resourceStatus: dto.resourceStatus });
    }

    // The version-history insert and the OCC Compare-And-Set now run
    // inside a SINGLE interactive transaction (canonical Prisma-7 idiom, see
    // TenantService / PromptManagementService). Previously these
    // were two independent awaits, so a stale `If-Match` that (correctly)
    // rejected the CAS with 412 still left the freshly-inserted version row
    // committed — a live-reproduced orphan. Running both writes in one tx means
    // the repository's `OptimisticConcurrencyException` (HTTP 412) — thrown from
    // inside the callback when the CAS matches 0 rows — aborts the transaction
    // and rolls the version row back, so NO orphan persists.
    //
    // The CAS guards the report row's `_version` OCC column.
    // `dto.expectedVersion` (folded from the admin route's required `If-Match`
    // header) is the CAS predicate input; it is DISTINCT from the DNA domain's
    // `currentVersionNumber` / `DnaVersion` history bumped above.
    const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
      if (version) {
        await this.dnaVersionRepository.create(version, tx);
      }
      return this.dnaReportRepository.updateWithVersion(reportId, report, dto.expectedVersion, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: reportId,
      data: { changeReason: dto.changeReason },
    });

    return DnaWritingStyleDtoMapper.toReportResponse(updated);
  }

  /**
   * Promote a historical report to the caller's active/default
   * (`isLatest`) report. The previous default is demoted so the doctor always
   * has exactly one latest report. Tenant scope (PHI guard) + owner scope are
   * both enforced; even an admin cannot set another doctor's default here (the
   * playground runs in the doctor's own/impersonated context).
   */
  async setDefaultReport(reportId: string): Promise<DnaReportResponse> {
    const userId = this.requestUserId;

    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
    this.assertReportInScope(report, reportId);

    if (report.doctorId !== userId) {
      throw new ForbiddenException("Cannot set another doctor's DNA report as default");
    }

    // Idempotent: already the default ⇒ nothing to flip.
    if (report.isLatest) {
      return DnaWritingStyleDtoMapper.toReportResponse(report);
    }

    const currentLatest = await this.dnaReportRepository.findLatestForDoctor(report.doctorId);
    if (currentLatest && currentLatest.id !== reportId) {
      currentLatest.unmarkAsLatest();
      await this.dnaReportRepository.update(currentLatest.id, currentLatest);
    }

    report.markAsLatest();
    const updated = await this.dnaReportRepository.update(reportId, report);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: reportId,
      data: { kind: 'dna-default-set', doctorId: report.doctorId },
    });

    return DnaWritingStyleDtoMapper.toReportResponse(updated);
  }

  /**
   * (audit C-9) — load the parent report first, assert it
   * belongs to the caller's tenant, and only then enumerate its versions.
   * Without this, a Tenant-A admin could enumerate versions of a Tenant-B
   * report by passing the foreign reportId.
   */
  async getVersions(reportId: string): Promise<DnaVersionResponse[]> {
    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
    this.assertReportInScope(report, reportId);

    const versions = await this.dnaVersionRepository.findAll({
      filters: { dnaReportId: reportId },
      sort: [{ versionNumber: 'desc' }],
    });
    return versions.map(DnaWritingStyleDtoMapper.toVersionResponse);
  }

  async getVersionsForDoctor(reportId: string, doctorId: string): Promise<DnaVersionResponse[]> {
    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
    // Tenant scope is the structural guard. The doctorId
    // ownership check below is the per-user escalation guard preserved from
    // the existing flow.
    this.assertReportInScope(report, reportId);

    if (report.doctorId !== doctorId) {
      throw new ForbiddenException("Cannot access another doctor's DNA report versions");
    }
    // Inline the version fetch to avoid a redundant `findById` round-trip.
    const versions = await this.dnaVersionRepository.findAll({
      filters: { dnaReportId: reportId },
      sort: [{ versionNumber: 'desc' }],
    });
    return versions.map(DnaWritingStyleDtoMapper.toVersionResponse);
  }

  private isGlobalRole(): boolean {
    const roles = this.requestUser?.roles ?? [];
    return roles.includes('GLOBAL_ADMIN');
  }

  /**
   * (audit C-9) — Assert the loaded report belongs to the
   * caller's tenant. Throws `NotFoundException` (not `Forbidden`) so the API
   * never reveals that a record exists for another tenant. Note: writing
   * style is PHI-derived, so GLOBAL_ADMIN does NOT bypass this check.
   */
  private assertReportInScope(report: { tenantId?: string | null }, reportId: string): void {
    const tenantId = this.tenantId;
    if (!tenantId || report.tenantId !== tenantId) {
      throw new NotFoundException(`DNA report ${reportId} not found`);
    }
  }

  async listReports(filters?: { doctorId?: string; includeDisabled?: boolean }): Promise<DnaReportResponse[]> {
    const tenantId = this.tenantId;

    if (!tenantId && !this.isGlobalRole()) {
      throw new BadRequestException('Tenant ID is required');
    }

    const qb = this.dnaReportRepository.$();
    if (tenantId) qb.Where({ tenantId });
    if (!filters?.includeDisabled) {
      qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    }
    if (filters?.doctorId) qb.Where({ doctorId: filters.doctorId });
    const models = await qb.ToList();
    const mapper = DnaWritingStyleReportEntityMapper.getInstance();
    const reports = models.map((m) => mapper.toDomainEntity(m));
    return reports.map((report) => DnaWritingStyleDtoMapper.toReportResponse(report));
  }

  /**
   * Repository-level paginated admin list.
   *
   * Pushes pagination down to the repository (`findPaginated` → `db.findMany` +
   * `db.count`) instead of materializing the full tenant result set and slicing
   * it in the controller. Tenant scope is resolved identically to
   * `getDashboard`/`resolveDashboardScope`: a global admin may target a tenant
   * via `tenantId` (or omit it for an all-tenants view); a tenant admin is
   * pinned to their CLS tenant and any supplied `tenantId` is ignored.
   */
  async listReportsPaginated(filters?: ListDnaReportsFilters): Promise<PaginatedDnaReports> {
    const scopeTenantId = this.resolveListScope(filters?.tenantId);

    const page = filters?.page && filters.page > 0 ? filters.page : 1;
    const limit = filters?.limit && filters.limit > 0 ? filters.limit : 50;

    const where: Record<string, unknown> = {};
    if (scopeTenantId) where.tenantId = scopeTenantId;
    if (!filters?.includeDisabled) where.resourceStatus = ResourceStatusType.ENABLED;
    if (filters?.doctorId) where.doctorId = filters.doctorId;

    const { data, count } = await this.dnaReportRepository.findPaginated(where, page, limit);
    // Batch-resolve the page's distinct doctors to usernames in a
    // single query (skipped entirely when the page is empty).
    const usernameById = await this.resolveDoctorUsernames(data.map((report) => report.doctorId));
    return {
      data: data.map((report) => DnaWritingStyleDtoMapper.toReportResponse(report, report.doctorId ? usernameById[report.doctorId] : undefined)),
      count,
      page,
      limit,
    };
  }

  /**
   * Aggregate DNA dashboard.
   *
   * Tenant scoping mirrors `listReports`: a global admin
   * (GLOBAL_ADMIN) may target a specific tenant via `tenantId`, or
   * omit it for an all-tenants roll-up. A tenant admin is always pinned to
   * their CLS tenant — any `tenantId` argument is ignored so they cannot read
   * another tenant's PHI-derived activity.
   */
  async getDashboard(tenantId?: string): Promise<DnaDashboardResponse> {
    const scopeTenantId = this.resolveDashboardScope(tenantId);

    const windowDays = DnaWritingStyleService.DASHBOARD_WINDOW_DAYS;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const [usersWithStyle, avgRaw, total, dailyCounts, latestRecords] = await Promise.all([
      this.dnaReportRepository.countDoctorsWithLatestReport(scopeTenantId),
      this.dnaReportRepository.averageCurrentVersion(scopeTenantId),
      this.dnaUsageRecordRepository.countSince(since, scopeTenantId),
      this.dnaUsageRecordRepository.getDailyUsageCounts(since, scopeTenantId),
      this.dnaUsageRecordRepository.findRecent(DnaWritingStyleService.DASHBOARD_LATEST_LIMIT, scopeTenantId),
    ]);

    return {
      usersWithStyle,
      avgVersions: Math.round(avgRaw * 100) / 100,
      recentActivity: {
        dailyCounts,
        latest: latestRecords.map(DnaWritingStyleDtoMapper.toUsageEntry),
        total,
        windowDays,
      },
    };
  }

  /**
   * CC-02 — resolve the tenant the admin *list* runs against.
   *
   * Mirrors `resolveDashboardScope`, EXCEPT a global admin who supplied no
   * explicit `tenantId` falls back to their ACTIVE tenant (the `X-Tenant-Id`
   * header surfaced on CLS as `tenantId`) before defaulting to the all-tenants
   * view. Without this, a super-admin who had selected an active tenant still
   * saw EVERY tenant's reports on the list whenever the `?tenantId` query param
   * was omitted (the header was ignored). A tenant admin stays pinned to their
   * CLS tenant exactly as before. The dashboard roll-up intentionally keeps its
   * all-tenants default, so it is left on `resolveDashboardScope`.
   */
  private resolveListScope(requestedTenantId?: string): string | undefined {
    if (this.isGlobalRole()) {
      return requestedTenantId ?? this.tenantId ?? undefined;
    }
    const ctxTenant = this.tenantId;
    if (!ctxTenant) {
      throw new BadRequestException('Tenant ID is required');
    }
    return ctxTenant;
  }

  /**
   * Resolve the tenant a dashboard request runs against. Global admins keep the
   * caller-supplied `tenantId` (possibly `undefined` ⇒ all tenants); tenant
   * admins are forced onto their CLS tenant and require one to be present.
   */
  private resolveDashboardScope(requestedTenantId?: string): string | undefined {
    if (this.isGlobalRole()) {
      return requestedTenantId ?? undefined;
    }
    const ctxTenant = this.tenantId;
    if (!ctxTenant) {
      throw new BadRequestException('Tenant ID is required');
    }
    return ctxTenant;
  }

  private static readonly DASHBOARD_WINDOW_DAYS = 30;
  private static readonly DASHBOARD_LATEST_LIMIT = 5;
}
