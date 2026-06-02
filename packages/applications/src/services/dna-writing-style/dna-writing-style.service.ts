import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
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
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { IDnaWritingStyleService, DnaJobResponse } from './IDnaWritingStyleService';
import { DnaReportResponse, DnaVersionResponse, GenerateDnaReportRequest, UpdateDnaReportRequest, DnaDashboardResponse } from './dto';
import { DnaWritingStyleDtoMapper } from './dna-writing-style.dto.mapper';
import { BaseService } from '../../common';
import { assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

export interface GenerateDnaReportJobPayload {
  jobId: string;
  doctorId: string;
  tenantId: string;
  userId: string;
  textSamples?: string[];
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
    // TASK-328 A5 — source for the aggregate dashboard's recent-activity feed.
    private readonly dnaUsageRecordRepository: DnaUsageRecordRepository,
    // TASK-305 D.5.3 (audit C-9) — needed by `assertUserBelongsToTenant` to
    // verify a `doctorId` is a member of the caller's tenant before any
    // DNA-style operation runs against PHI-derived artifacts.
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    @InjectQueue(JobQueue.GenerateDnaReport) private readonly dnaQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.DnaWritingStyleReport);
  }

  /**
   * TASK-305 D.5.3 (audit C-9) — Queue a DNA-style generation job for a
   * doctor. The doctor must be a role-assigned member of the caller's
   * tenant; SUPER_ADMIN does NOT bypass this guard because writing-style
   * artifacts are derived from PHI (transcripts, prior notes), and exposing
   * them across tenants is itself a PHI leak.
   */
  async generateDnaReport(doctorId: string, dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, doctorId, tenantId);

    const userId = this.requestUserId ?? '';
    const jobId = uuidv7();

    const payload: GenerateDnaReportJobPayload = {
      jobId,
      doctorId,
      tenantId,
      userId,
      textSamples: dto.textSamples,
    };

    await this.dnaQueue.add(JobQueue.GenerateDnaReport, payload, {
      jobId,
    });

    // TASK-326 X9 — audit the generation REQUEST. The report row itself is
    // created asynchronously by the worker, but the privileged act of triggering
    // DNA (PHI-derived) generation for a doctor must appear on the audit trail.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: doctorId,
      data: { jobId, doctorId, kind: 'dna-generation-requested' },
    });

    return { jobId, status: 'PENDING' };
  }

  /**
   * TASK-305 D.5.3 (audit C-9) — `doctorId` must belong to the caller's
   * tenant; we surface a `NotFoundException` (no existence leak) for any
   * cross-tenant lookup attempt before the repository is consulted.
   */
  async getDnaReport(doctorId: string): Promise<DnaReportResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, doctorId, tenantId);

    const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
    if (!report) return null;
    return DnaWritingStyleDtoMapper.toReportResponse(report);
  }

  async updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse> {
    const userId = this.requestUserId;

    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);

    // TASK-305 D.5.3 (audit C-9) — PHI guard. Even an admin caller using
    // `bypassOwnershipCheck` (the per-doctor ownership escape) cannot reach
    // across tenants, and even SUPER_ADMIN cannot — the writing style
    // captures the doctor's voice/style derived from PHI.
    this.assertReportInScope(report, reportId);

    if (!options?.bypassOwnershipCheck && report.doctorId !== userId) {
      throw new ForbiddenException("Cannot update another doctor's DNA report");
    }

    const hasContentChanges = dto.reportData !== undefined || dto.styleText !== undefined;

    if (hasContentChanges) {
      const existingVersions = await this.dnaVersionRepository.findAll({
        filters: { dnaReportId: reportId },
        sort: [{ versionNumber: 'desc' }],
        limit: 1,
      });
      const highestExistingVersion = existingVersions[0]?.versionNumber ?? 0;
      const nextVersionNumber = Math.max(highestExistingVersion, report.currentVersionNumber ?? 0) + 1;

      const version = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
        tenantId: report.tenantId,
        dnaReportId: reportId,
        versionNumber: nextVersionNumber,
        reportData: dto.reportData ?? report.reportData,
        styleText: dto.styleText ?? report.styleText,
        changeReason: dto.changeReason ?? null,
        changedBy: userId ?? null,
      });

      await this.dnaVersionRepository.create(version);

      if (dto.reportData !== undefined) report.reportData = dto.reportData;
      if (dto.styleText !== undefined) report.styleText = dto.styleText;
      report.currentVersionNumber = nextVersionNumber;
    }

    if (dto.resourceStatus !== undefined) {
      await this.updateEntity(report, { resourceStatus: dto.resourceStatus });
    }

    const updated = await this.dnaReportRepository.update(reportId, report);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: reportId,
      data: { changeReason: dto.changeReason },
    });

    return DnaWritingStyleDtoMapper.toReportResponse(updated);
  }

  /**
   * TASK-305 D.5.3 (audit C-9) — load the parent report first, assert it
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
    // TASK-305 D.5.3 — tenant scope is the structural guard. The doctorId
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
    return roles.some((r) => r === 'SUPER_ADMIN' || r === 'GLOBAL_ADMIN');
  }

  /**
   * TASK-305 D.5.3 (audit C-9) — Assert the loaded report belongs to the
   * caller's tenant. Throws `NotFoundException` (not `Forbidden`) so the API
   * never reveals that a record exists for another tenant. Note: writing
   * style is PHI-derived, so SUPER_ADMIN does NOT bypass this check.
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
    return reports.map(DnaWritingStyleDtoMapper.toReportResponse);
  }

  /**
   * TASK-328 A5 — Aggregate DNA dashboard.
   *
   * Tenant scoping mirrors `listReports`: a global admin
   * (SUPER_ADMIN/GLOBAL_ADMIN) may target a specific tenant via `tenantId`, or
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
