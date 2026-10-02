import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DnaSampleSource,
  DnaWritingSampleRepository,
  DnaWritingStyleReportRepository,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserProfileRepository,
  UserRepository,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { ConfigResolver } from '../config-resolver';
import { SettingsRegistryWriteService } from '../settings-registry/settings-registry-write.service';
import { DNA_REGEN_KEYS } from '../settings-registry/descriptors/dna-regeneration.descriptors';
import { DnaRegenerationScheduler } from './dna-regeneration.scheduler';
import {
  DnaMemoryDoctorSummaryResponse,
  DnaMemorySamplePageResponse,
  DnaMemorySampleResponse,
  DnaRegenRunResponse,
  DnaRegenScheduleResponse,
  ListDnaMemoryQuery,
  UpdateDnaRegenScheduleRequest,
} from './dto';

const PREVIEW_MAX_CHARS = 200;
const DEFAULT_PAGE_SIZE = 20;

/**
 * TASK-1034 — the tenant-admin surface over DNA writing-style MEMORY and the weekly schedule.
 *
 * Tenant = the caller's CLS tenant (a super admin's working tenant). A clinician or sample of
 * another tenant is 404, never 403. Sample text is never returned: only a ≤200-character preview,
 * PHI-redacted through the same `IPhiRedactor` hop the DNA corpus goes through — and an EMPTY
 * preview when redaction is unavailable, never unredacted text.
 */
@Injectable()
export class DnaMemoryAdminService extends BaseService {
  private readonly logger = new Logger(DnaMemoryAdminService.name);

  constructor(
    private readonly sampleRepository: DnaWritingSampleRepository,
    private readonly reportRepository: DnaWritingStyleReportRepository,
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly scheduler: DnaRegenerationScheduler,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    @Optional() @Inject(SettingsRegistryWriteService) private readonly settingsWrite?: SettingsRegistryWriteService,
  ) {
    super(eventEmitter, clsService, ResourceType.DnaWritingSample);
  }

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    return tenantId;
  }

  // ── Memory ─────────────────────────────────────────────────────

  async getMemorySummary(): Promise<DnaMemoryDoctorSummaryResponse[]> {
    const tenantId = this.requireTenant();
    const [memory, reports] = await Promise.all([
      this.sampleRepository.summarizeByDoctor(tenantId),
      this.reportRepository.findAll({ filters: { tenantId, isLatest: true, resourceStatus: ResourceStatusType.ENABLED } } as never),
    ]);
    const latest = new Map<string, { id: string; at: Date }>();
    for (const report of reports ?? []) {
      if (!report?.doctorId) continue;
      const at = new Date(report.createdAt ?? 0);
      const seen = latest.get(report.doctorId);
      if (!seen || at > seen.at) latest.set(report.doctorId, { id: report.id, at });
    }
    const byDoctor = new Map(memory.map((m) => [m.doctorId, m]));
    const doctorIds = [...new Set([...byDoctor.keys(), ...latest.keys()])].sort();
    if (doctorIds.length === 0) return [];

    const [users, profiles] = await Promise.all([
      this.userRepository.findAll({ where: { id: { in: doctorIds } } } as never),
      this.userProfileRepository.findAll({ where: { userId: { in: doctorIds } } } as never),
    ]);
    const username = new Map((users ?? []).map((u) => [u.id, u.username ?? null]));
    const displayName = new Map((profiles ?? []).map((p) => [p.userId, [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || null] as const));

    const rows: DnaMemoryDoctorSummaryResponse[] = [];
    for (const doctorId of doctorIds) {
      const m = byDoctor.get(doctorId);
      const report = latest.get(doctorId);
      rows.push({
        doctorId,
        username: username.get(doctorId) ?? null,
        displayName: displayName.get(doctorId) ?? null,
        total: m?.total ?? 0,
        unconsumed: m?.unconsumed ?? 0,
        bySource: m?.bySource ?? { EDIT: 0, SIGNOFF: 0, INGEST: 0 },
        lastSampleAt: m?.lastSampleAt ? new Date(m.lastSampleAt).toISOString() : null,
        lastReportAt: report ? report.at.toISOString() : null,
        latestReportId: report?.id ?? null,
        dnaEnabled: await this.dnaEnabled(tenantId, doctorId),
      });
    }
    return rows;
  }

  async listMemory(query: ListDnaMemoryQuery): Promise<DnaMemorySamplePageResponse> {
    const tenantId = this.requireTenant();
    if (query.doctorId) {
      await assertUserBelongsToTenant(
        this.userRoleAssignmentRepository,
        this.userDepartmentRepository,
        this.userRepository,
        query.doctorId,
        tenantId,
      );
    }
    const page = query.page && query.page >= 1 ? query.page : 1;
    const limit = query.limit && query.limit >= 1 ? Math.min(query.limit, 100) : DEFAULT_PAGE_SIZE;
    const filter = {
      tenantId,
      ...(query.doctorId ? { doctorId: query.doctorId } : {}),
      ...(query.source ? { source: query.source as DnaSampleSource } : {}),
      ...(query.consumed !== undefined ? { consumed: query.consumed } : {}),
    };
    const { data, count } = await this.sampleRepository.findPaginated(filter, page, limit);
    const rows = await Promise.all(data.map((sample) => this.toSampleResponse(sample)));
    return { data: rows, count, page, limit };
  }

  async deleteMemory(id: string): Promise<void> {
    const tenantId = this.requireTenant();
    let sample: { id: string; tenantId: string; doctorId?: string } | null = null;
    try {
      sample = await this.sampleRepository.findById(id);
    } catch {
      sample = null;
    }
    if (!sample || sample.tenantId !== tenantId) throw new NotFoundException('Resource not found');
    await this.sampleRepository.softDelete(id, this.requestUserId ?? undefined);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId: id, data: { doctorId: sample.doctorId, kind: 'dna-memory-sample' } });
  }

  // ── Schedule ───────────────────────────────────────────────────

  async getSchedule(): Promise<DnaRegenScheduleResponse> {
    const tenantId = this.requireTenant();
    const config = this.scheduler.getConfig(tenantId);
    const next = this.scheduler.nextRunAt(tenantId);
    const lastRun = await this.scheduler.getLastRun(tenantId);
    return {
      enabled: config.enabled,
      cron: config.cron,
      minNewSamples: config.minNewSamples,
      timeZone: config.timeZone,
      nextRunAt: next ? next.toISOString() : null,
      lastRun,
    };
  }

  /**
   * Write the supplied keys at TENANT scope through the governed registry lane (validation, sys
   * events, cache refresh). No If-Match on this route: the current tenant row version is read
   * fresh and used as the compare-and-set, so a concurrent write between the read and the write
   * still fails 412 rather than being clobbered.
   */
  async updateSchedule(dto: UpdateDnaRegenScheduleRequest): Promise<DnaRegenScheduleResponse> {
    this.requireTenant();
    if (!this.settingsWrite) throw new BadRequestException('Settings are not writable in this deployment');
    const writes: Array<[string, unknown]> = [];
    if (dto.enabled !== undefined) writes.push([DNA_REGEN_KEYS.enabled, dto.enabled]);
    if (dto.cron !== undefined) writes.push([DNA_REGEN_KEYS.cron, dto.cron]);
    if (dto.minNewSamples !== undefined) writes.push([DNA_REGEN_KEYS.minNewSamples, dto.minNewSamples]);
    for (const [key, value] of writes) {
      const version = await this.settingsWrite.getBackingRowVersion(key, 'tenant');
      await this.settingsWrite.write(key, value, version > 0 ? { scope: 'tenant', expectedVersion: version } : { scope: 'tenant' });
    }
    return this.getSchedule();
  }

  async runNow(): Promise<DnaRegenRunResponse> {
    const tenantId = this.requireTenant();
    const result = await this.scheduler.runForTenant(tenantId);
    return { queued: result.queued, skipped: result.skipped, jobs: result.jobs };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private async dnaEnabled(tenantId: string, doctorId: string): Promise<boolean> {
    if (!this.configResolver) return false;
    try {
      return (await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId })).effective === true;
    } catch {
      return false;
    }
  }

  private async toSampleResponse(sample: {
    id: string;
    doctorId: string;
    source: string;
    kind?: string | null;
    writtenAt: Date;
    sourceRef?: string | null;
    consultationId?: string | null;
    consumedByReportId?: string | null;
    textCiphertext?: Buffer | null;
    createdAt?: Date;
  }): Promise<DnaMemorySampleResponse> {
    return {
      id: sample.id,
      doctorId: sample.doctorId,
      source: sample.source as DnaMemorySampleResponse['source'],
      kind: sample.kind ?? null,
      writtenAt: new Date(sample.writtenAt).toISOString(),
      sourceRef: sample.sourceRef ?? null,
      consultationId: sample.consultationId ?? null,
      consumed: !!sample.consumedByReportId,
      consumedByReportId: sample.consumedByReportId ?? null,
      preview: await this.preview(sample.id, sample.textCiphertext),
      createdAt: new Date(sample.createdAt ?? 0).toISOString(),
    };
  }

  /** Decrypt → redact (full) → truncate. Any failure ⇒ '' (never unredacted text). */
  private async preview(id: string, ciphertext: Buffer | null | undefined): Promise<string> {
    if (!this.phiRedactor || !this.secretsService || !ciphertext) return '';
    try {
      const text = await this.sampleRepository.decryptText(this.secretsService, ciphertext);
      if (!text) return '';
      // Redact a bounded window: the preview never needs more, and redaction is an HTTP hop.
      const redacted = await this.phiRedactor.redact(text.slice(0, PREVIEW_MAX_CHARS * 2), 'full');
      const flat = redacted.replace(/\s+/g, ' ').trim();
      return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…` : flat;
    } catch (error) {
      this.logger.warn(`DNA memory preview unavailable for sample ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }
}
