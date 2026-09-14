import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger, Optional } from '@nestjs/common';
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
  UserSettingsFactory,
  UserSettingsRepository,
  ValueType,
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
  DnaErasureResponse,
  DnaIngestJobResponse,
  DNA_INGEST_LIMITS,
  IngestDnaWritingSamplesRequest,
} from './dto';
import { DnaWritingStyleDtoMapper } from './dna-writing-style.dto.mapper';
import { RedactionRuleSet, validateRedactionRuleSet } from './redaction-rules';
// The per-doctor DNA toggle is stored on the Phase-5
// TASK-882: the doctor's DNA on/off preference is a `UserSettings` row (`dna` /
// `styleEnabled`); this service is the doctor self-service surface that writes it, and
// `ConfigResolver` reads it together with the tenant's `agent.dna_style` node.
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ConfigResolver, DNA_STYLE_PREFERENCE } from '../config-resolver';
import { SecretsService } from '../baseServices/_meta/secrets';
import { BaseService, encryptPhiFields } from '../../common';
import { assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

/** TASK-974 §4.1 — what a caller may say a writing sample IS. Explainability only; never a gate. */
export type DnaWritingSampleKind = 'CASE_NOTE' | 'WORK_NOTE' | 'OTHER';

/** TASK-974 §4.1 — ONE writing sample of the ingested time series. */
export interface DnaWritingSample {
  text: string;
  /** ISO-8601 date-time — the time-series key the corpus is ordered and truncated by. */
  writtenAt: string;
  kind: DnaWritingSampleKind;
  /** The caller's own record locator. Carried for support, NEVER persisted on the report. */
  sourceRef?: string;
}

/**
 * TASK-974 §4.3 — WHO asked, for a machine caller.
 *
 * The job-status route lets a machine read back only the jobs it enqueued, and this is the only
 * record of that: a service account and an API key both act "as" a bound user, so the user id
 * alone cannot tell one credential's job from another's.
 */
export interface DnaJobRequestedBy {
  credentialClass: 'jwt' | 'api-key' | 'service-account';
  /** The CREDENTIAL's id — a `ServiceAccount.id` or an `ApiKey.id`, never the bound user's. */
  principalId: string;
}

export interface GenerateDnaReportJobPayload {
  jobId: string;
  doctorId: string;
  tenantId: string;
  userId: string;
  textSamples?: string[];
  // Historical source IDs the generation was seeded from.
  sourceIds?: string[];
  /**
   * TASK-974 §4.3 — the ingested TIME SERIES. Additive beside `textSamples` rather than
   * replacing it: the two carry different things (an unordered bag of strings vs. dated,
   * typed items) and the older callers keep working byte-identically.
   *
   * The batch rides the payload rather than a table by design (D-3): the raw notes are PHI, and
   * the durable artifact is the schema-constrained PROFILE, not the writing that produced it.
   */
  samples?: DnaWritingSample[];
  /** Which surface asked. Stamped on the audit event so a profile's provenance is readable. */
  origin?: 'generate' | 'ingest' | 'scheduler';
  requestedBy?: DnaJobRequestedBy;
}

export interface DnaReportJobResult {
  reportId: string;
  reportData: Record<string, unknown>;
  styleText: string;
}

/**
 * TASK-974 §4.1 — the roles that may ingest on ANOTHER clinician's behalf.
 *
 * Mirrors `DNA_ADMIN_ROLES` in `dna-writing-style.controller.ts`. The SUPER_ADMIN member is not
 * a widening: it is the same "an administrator does administrative acts" rule, and a super admin
 * still cannot cross a tenant here — `assertUserBelongsToTenant` runs on the named id regardless
 * of role, because these artifacts are PHI-derived.
 */
const DNA_INGEST_ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

/** The clinical roles a caller must hold to ingest samples under their OWN account. */
const DNA_CLINICIAN_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

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
    // DI supplies it via ConfigResolverModule.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // Optional + trailing (same arity rationale). When wired,
    // manual report edits encrypt reportData/styleText into the ciphertext
    // columns before persisting; left unpersisted when unset (there is no plaintext column).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-882 — the doctor's DNA preference row. Optional + trailing so positional fixtures
    // keep their arity; production DI supplies it via CoreDatabaseModule.
    @Optional() @Inject(UserSettingsRepository) private readonly userSettingsRepository?: UserSettingsRepository,
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
   * tenant; SUPER_ADMIN does NOT bypass this guard because writing-style
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
   * TASK-974 §4.1 — ingest a TIME SERIES of writing samples for a clinician.
   *
   * ─── Why this is not `generateDnaReport` with a richer body ────────────────────────────────
   *
   * `generate` is a clinician asking the platform to re-read THEIR OWN already-stored notes. This
   * is a caller — usually a machine, usually a back-office integration out of an EMR — SUBMITTING
   * writing the platform has never seen, on a named clinician's behalf. Different subject,
   * different credential classes, different authorization rule; the two share a queue and nothing
   * else.
   *
   * ─── The authorization rule, which no decorator can state ──────────────────────────────────
   *
   * The route carries a bare `@Authorize()` plus its scopes, and the real gate is here:
   *
   *  · a MACHINE (API key / service account) MUST name a clinician. It is never one itself, and
   *    a machine's bound user is an implementation detail of the credential, not a clinician
   *    whose writing style anybody asked for.
   *  · a HUMAN who names nobody gets themselves — but only if they are acting as a clinician.
   *    An admin who is neither a clinical user nor impersonating one would otherwise build a
   *    writing-style profile under their own account, which is `generate`'s rule verbatim and
   *    exists for the same reason.
   *  · a HUMAN who names somebody else is performing an administrative act, so it takes
   *    SUPER_ADMIN or TENANT_ADMIN. A clinician naming another clinician is 400, not 403: the
   *    request is refused on WHO it names, and there is no id to protect — they are being told
   *    about a rule, not about a row.
   *  · whoever is named must be a member of the caller's tenant, and a cross-tenant id is 404
   *    (`assertUserBelongsToTenant`) — the house posture, and doubly right here because a DNA
   *    profile is derived from PHI.
   *
   * The DNA gate (tenant AND doctor) is pre-checked so a caller learns immediately rather than by
   * polling a job that was always going to fail; the processor re-checks it anyway, because the
   * toggle may flip between enqueue and run.
   */
  async ingestWritingSamples(dto: IngestDnaWritingSamplesRequest, caller: DnaJobRequestedBy): Promise<DnaIngestJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const doctorId = this.resolveIngestClinician(dto.clinicianUserId, caller);
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    const totalChars = dto.items.reduce((sum, item) => sum + item.text.length, 0);
    if (totalChars > DNA_INGEST_LIMITS.maxTotalChars) {
      throw new BadRequestException({
        code: 'DNA_INGEST_TOO_LARGE',
        message: `This batch carries ${totalChars} characters; at most ${DNA_INGEST_LIMITS.maxTotalChars} may be submitted in one request. Split it and submit the oldest samples first.`,
      });
    }

    // Pre-check the effective DNA decision (tenant graph AND the doctor's own opt-in). Absent
    // resolver ⇒ no-op, matching every other `@Optional()` ConfigResolver call site: an unwired
    // dependency is a composition that reads no such flag, not a defect.
    if (this.configResolver) {
      const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
      if (!effective) {
        throw new ConflictException({
          code: 'DNA_STYLE_DISABLED',
          message:
            'DNA writing style is disabled for this clinician — either the tenant has not enabled it or the clinician has opted out. Ingested samples would be discarded, so nothing was queued.',
        });
      }
    }

    const samples: DnaWritingSample[] = dto.items.map((item) => ({
      text: item.text,
      writtenAt: item.writtenAt,
      kind: item.kind ?? 'OTHER',
      ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}),
    }));
    const writtenAtMs = samples.map((sample) => Date.parse(sample.writtenAt));

    const jobId = uuidv7();
    const payload: GenerateDnaReportJobPayload = {
      jobId,
      doctorId,
      tenantId,
      // The CLINICIAN, not the machine. This becomes `createdBy` on the report, and a profile
      // attributed to a service account would be attributed to nobody. For a human caller
      // `requestUserId` IS the clinician (or the admin acting for them, which is the record the
      // audit event keeps); the credential itself is in `requestedBy`.
      userId: this.requestUserId ?? doctorId,
      samples,
      origin: 'ingest',
      requestedBy: caller,
    };

    await this.dnaQueue.add(JobQueue.GenerateDnaReport, payload, { jobId });

    // Audit the REQUEST. COUNTS and IDS only: the samples are PHI and `sourceRef` is the caller's
    // own record locator, so neither belongs on an audit row that outlives the job.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: doctorId,
      data: {
        jobId,
        doctorId,
        kind: 'dna-ingest-requested',
        origin: 'ingest',
        itemCount: samples.length,
        credentialClass: caller.credentialClass,
        principalId: caller.principalId,
      },
    });

    return {
      jobId,
      status: 'PENDING',
      clinicianUserId: doctorId,
      acceptedItems: samples.length,
      window: {
        from: new Date(Math.min(...writtenAtMs)).toISOString(),
        to: new Date(Math.max(...writtenAtMs)).toISOString(),
      },
    };
  }

  /** @see ingestWritingSamples — the four-way rule, stated once. */
  private resolveIngestClinician(named: string | undefined, caller: DnaJobRequestedBy): string {
    if (caller.credentialClass !== 'jwt') {
      if (!named) {
        throw new BadRequestException({
          code: 'DNA_INGEST_CLINICIAN_REQUIRED',
          message: 'A machine credential must name the clinician these samples belong to (`clinicianUserId`); it is never the clinician itself.',
        });
      }
      return named;
    }

    const user = this.requestUser;
    const callerId = user?.id;
    if (!callerId) {
      throw new BadRequestException('User context is required');
    }

    if (!named || named === callerId) {
      this.assertActingAsClinician();
      return callerId;
    }

    const roles = user?.roles ?? [];
    if (!roles.some((role) => DNA_INGEST_ADMIN_ROLES.includes(role))) {
      throw new BadRequestException({
        code: 'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
        message:
          'Only a tenant or super administrator may ingest writing samples on another clinician`s behalf. Omit `clinicianUserId` to ingest your own.',
      });
    }
    return named;
  }

  /**
   * `DnaWritingStyleController.assertActingAsDoctor`, applied to ingest.
   *
   * Duplicated as a private method rather than shared, because the CONTROLLER's copy guards a
   * route whose subject is derived from CLS with no id at all, while this one guards the
   * "named nobody" branch of a route that also accepts an id. Sharing them would put the rule in
   * a place where it looked unconditional and is not.
   */
  private assertActingAsClinician(): void {
    const user = this.requestUser;
    const roles = user?.roles ?? [];
    const isAdmin = roles.some((role) => DNA_INGEST_ADMIN_ROLES.includes(role));
    const isClinician = roles.some((role) => DNA_CLINICIAN_ROLES.includes(role));
    if (isAdmin && !isClinician && !user?.impersonatedBy) {
      throw new ForbiddenException(
        'DNA writing styles are personalized per clinician. Name a `clinicianUserId`, or impersonate a clinician — an administrator cannot build one under their own account.',
      );
    }
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
   * Read the doctor's decrypted DNA redaction/rewrite rule set from
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
    // dev/test). A report predating has no rules ⇒ empty set.
    if (this.secretsService) {
      const { redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
      if (redactionRules) return validateRedactionRuleSet(redactionRules);
    }
    return { rules: [] };
  }

  /**
   * The doctor's DECRYPTED DNA writing-style text for prompt
   * injection, or `null` when DNA style is not applicable. Composes the same
   * pieces the doctor-facing reads use: the tenant PHI guard, the effective
   * on/off gate (`tenant AND doctor`), the latest report, and ciphertext
   * decryption. Returns `null` — never throws — when the gate is off, there is no
   * report/style, or the secrets backend is unwired, so callers can treat DNA as
   * purely additive.
   */
  async getEffectiveStyleText(doctorId: string, explicitTenantId?: string): Promise<string | null> {
    // `explicitTenantId` exists because the CLS getter is not always
    // populated: the v1-compat TEXT surface authenticates by API KEY, and only the
    // JWT strategy writes CLS `tenantId`. Its controller already resolves the
    // authoritative tenant (`requireTenantId` → CLS, else `apiKey.tenantId`) and
    // hands it to every other resolver on that path; this method re-read CLS and
    // so threw on every API-key call, silently dropping DNA style from every
    // summary. The argument is NOT a tenant override for untrusted input — it is
    // the same authenticated value, passed instead of re-derived — and
    // `assertUserBelongsToTenant` below still proves the doctor is in it.
    const tenantId = explicitTenantId?.trim() || this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    // Effective = the tenant's `agent.dna_style` node AND the doctor's own toggle. Off ⇒ no
    // style. Resolved against the SAME tenant, not CLS again — `getDnaSettings` has the
    // identical CLS dependency and would re-introduce the failure here.
    const settings = await this.requireConfigResolver().resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
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
   * preference-row OCC version. Delegates the decision to {@link ConfigResolver} (TASK-882).
   */
  async getDnaSettings(doctorId: string): Promise<DnaSettingsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const s = await this.requireConfigResolver().resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
    return { doctorToggle: s.doctorToggle, tenantEnabled: s.tenantEnabled, effective: s.effective, version: s.doctorPreferenceVersion };
  }

  /**
   * WRITE the caller doctor's DNA on/off toggle (TASK-882: a `UserSettings` row, `dna` /
   * `styleEnabled` — the clinician's own preference, P-4). A null `enabled` clears the
   * override (the row is soft-deleted; revert to the implicit opt-in default). Optimistic
   * concurrency is the row's `_version`: `GET settings` answers `version: 0` while no row
   * exists, and a stale `expectedVersion` is a 412. A `ResourceUpdated` SysEvent is broadcast
   * so the audit trail records the privileged self-service change. The DNA processor's
   * effective-flag gate then honours an opt-out on the NEXT batch (no synchronous re-learning).
   */
  async setDnaEnabled(doctorId: string, dto: UpdateDnaSettingsRequest): Promise<DnaSettingsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const repository = this.requireUserSettingsRepository();
    const enabled = dto.enabled ?? null;
    const { namespace, key, name } = DNA_STYLE_PREFERENCE;

    const existing = await repository.findByUserKeyNamespace(doctorId, key, namespace);
    // The OCC precondition, evaluated BEFORE any no-op short-circuit: a stale client must get
    // 412 ("you are stale, refetch") even when the payload would change nothing.
    const currentVersion = existing?.version ?? 0;
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== null && dto.expectedVersion !== currentVersion) {
      throw new OptimisticConcurrencyException('UserSettings', existing?.id ?? doctorId, { expectedVersion: dto.expectedVersion, currentVersion });
    }

    if (enabled === null) {
      if (existing) await repository.softDelete(existing.id);
    } else if (existing) {
      const value = String(enabled);
      if (existing.value !== value) {
        this.updateEntity(existing, { value });
        await repository.update(existing.id, existing);
      }
    } else {
      await repository.create(
        UserSettingsFactory.CreateUserSettings({
          userId: doctorId,
          key,
          namespace,
          name,
          value: String(enabled),
          dataType: ValueType.Boolean,
          createdBy: this.requestUser?.id,
        }),
      );
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: doctorId,
      data: { kind: 'dna-settings-updated', doctorId, enabled, reason: dto.reason ?? null },
    });

    return this.getDnaSettings(doctorId);
  }

  /** Guard the optional dependencies so a misconfigured DI surfaces a clear 400. */
  private requireConfigResolver(): ConfigResolver {
    if (!this.configResolver) {
      throw new BadRequestException('DNA settings are not available');
    }
    return this.configResolver;
  }

  private requireUserSettingsRepository(): UserSettingsRepository {
    if (!this.userSettingsRepository) {
      throw new BadRequestException('DNA settings are not available');
    }
    return this.userSettingsRepository;
  }

  async updateDnaReport(reportId: string, dto: UpdateDnaReportRequest, options?: { bypassOwnershipCheck?: boolean }): Promise<DnaReportResponse> {
    const userId = this.requestUserId;

    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);

    // (audit C-9) — PHI guard. Even an admin caller using
    // `bypassOwnershipCheck` (the per-doctor ownership escape) cannot reach
    // across tenants, and even SUPER_ADMIN cannot — the writing style
    // captures the doctor's voice/style derived from PHI.
    this.assertReportInScope(report, reportId);

    if (!options?.bypassOwnershipCheck && report.doctorId !== userId) {
      throw new ForbiddenException("Cannot update another doctor's DNA report");
    }

    // Validate the redaction rule set's JSON shape up front (a 400
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
  async setDefaultReport(reportId: string, expectedVersion?: number): Promise<DnaReportResponse> {
    const userId = this.requestUserId;

    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
    this.assertReportInScope(report, reportId);

    if (report.doctorId !== userId) {
      throw new ForbiddenException("Cannot set another doctor's DNA report as default");
    }

    // OCC precondition BEFORE the idempotent short-circuit below: promoting an
    // already-default report is a no-op, but a client holding a stale version
    // must still be told to refetch (412) rather than receive a 200 that
    // certifies a precondition nobody evaluated.
    this.assertExpectedVersion(report, expectedVersion, 'dnaWritingStyleReport');

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
    const updated =
      expectedVersion === undefined
        ? await this.dnaReportRepository.update(reportId, report)
        : await this.dnaReportRepository.updateWithVersion(reportId, report, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: reportId,
      data: { kind: 'dna-default-set', doctorId: report.doctorId },
    });

    return DnaWritingStyleDtoMapper.toReportResponse(updated);
  }

  /**
   * Erase the CALLER'S OWN learned writing-style profile in full — every
   * report plus every historical version (INV-240 / INV-241).
   *
   * Opting out (`PUT /dna-writing-styles/settings`) only stops FUTURE
   * learning; the profile already learned stays stored and keeps being
   * injected into the doctor's summary prompts. INV-167 requires style
   * learning to be "reversible by the clinician", which is only true with an
   * erasure path, so this is the other half of the opt-out.
   *
   * Self-service by construction: the subject is always `requestUserId`, so
   * there is no id to smuggle and no way to erase someone else's profile.
   * Idempotent — a doctor with no profile resets to zero counts.
   */
  async resetMyDnaProfile(): Promise<DnaErasureResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const doctorId = this.requestUserId;
    if (!doctorId) {
      throw new BadRequestException('User context is required');
    }

    const reports = await this.dnaReportRepository.findAllForDoctor(doctorId);
    // Defense in depth: the extended client already scopes reads by tenant,
    // but erasure is destructive enough to re-assert it here rather than
    // trust the extension to have been applied.
    const owned = (reports ?? []).filter((report) => report.tenantId === tenantId);

    return this.eraseReports(owned, doctorId);
  }

  /**
   * Admin-triggered erasure of a DOCTOR's learned writing-style profile — the
   * admin half of INV-240's "deletable" requirement, complementing the doctor
   * self-service {@link resetMyDnaProfile}. Lets a tenant admin honour an
   * erasure request (or respond to an incident) without impersonating the
   * clinician.
   *
   * `doctorId` must be a member of the ACTING ADMIN's tenant — the same
   * `assertUserBelongsToTenant` guard `generateDnaReport`/`getDnaReport`
   * already apply — so a cross-tenant `doctorId` surfaces as
   * `NotFoundException` (404-over-403) rather than erasing nothing and
   * reporting success, or confirming that the id exists elsewhere.
   *
   * Soft delete only, exactly like {@link resetMyDnaProfile}: it shares
   * {@link eraseReports}, so the rows stay auditable, drop out of every read
   * path, and are hard-deleted later by the scheduled DNA profile retention
   * purge. Idempotent — a doctor with no profile resets to zero counts.
   */
  async resetDoctorDnaProfile(doctorId: string): Promise<DnaErasureResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, doctorId, tenantId);

    const reports = await this.dnaReportRepository.findAllForDoctor(doctorId);
    // Defense in depth, mirroring `resetMyDnaProfile`: the extended client
    // already scopes reads by tenant, but erasure is destructive enough to
    // re-assert it rather than trust the extension to have been applied.
    const owned = (reports ?? []).filter((report) => report.tenantId === tenantId);

    return this.eraseReports(owned, doctorId);
  }

  /**
   * Erase ONE of the caller's own writing-style reports (and its versions).
   * Complements {@link resetMyDnaProfile} for a doctor who wants to drop a
   * single bad snapshot rather than the whole profile.
   *
   * Cross-tenant ids surface as 404 (never 403) via
   * {@link assertReportInScope}, so the API never reveals that a record
   * exists for another tenant. A same-tenant report owned by a DIFFERENT
   * doctor is a genuine privilege boundary, not an existence question, so it
   * is a 403 — mirroring `setDefaultReport`.
   */
  async deleteReport(reportId: string): Promise<DnaErasureResponse> {
    const report = await this.dnaReportRepository.findById(reportId);
    if (!report) throw new NotFoundException(`DNA report ${reportId} not found`);
    this.assertReportInScope(report, reportId);

    const userId = this.requestUserId;
    if (report.doctorId !== userId) {
      throw new ForbiddenException("Cannot erase another doctor's DNA writing-style report");
    }

    return this.eraseReports([report], report.doctorId ?? userId);
  }

  /**
   * Soft-delete the given reports, broadcasting one `ResourceDeleted` per
   * report. Soft delete (never hard delete) per `03-domain-layer.md`: the
   * rows stay auditable while dropping out of every read path, and
   * `getEffectiveStyleText` therefore stops injecting them.
   *
   * `DnaWritingStyleVersion` carries NO `resourceStatus` column
   * (`MODELS_WITHOUT_SOFT_DELETE` — `packages/database/src/client.ts`), so it
   * CANNOT be soft-deleted — calling `.softDelete()` on it throws. Versions
   * are therefore only COUNTED here, never mutated: they become unreachable
   * the instant their parent report is soft-deleted (`getVersions` /
   * `getVersionsForDoctor` load the parent report first and 404 once it is
   * gone), and (owner ruling, 2026-08-20) hard-deletes them
   * together with their report once `DnaProfileRetentionService`'s retention
   * window elapses — the "purge later" half of "soft delete now, purge
   * later". Erasing them here, ahead of that window, would erase their
   * PHI-derived ciphertext sooner than the report's own, which the ruling
   * does not intend.
   */
  private async eraseReports(reports: { id: string; doctorId?: string | null }[], doctorId: string): Promise<DnaErasureResponse> {
    let deletedVersions = 0;

    for (const report of reports) {
      const versions = await this.dnaVersionRepository.findAll({ filters: { dnaReportId: report.id } });
      deletedVersions += (versions ?? []).length;

      await this.dnaReportRepository.softDelete(report.id);

      this.broadcastSysEvent(SysEventType.ResourceDeleted, {
        resourceId: report.id,
        data: { kind: 'dna-profile-reset', doctorId },
      });
    }

    return { doctorId, deletedReports: reports.length, deletedVersions };
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
    return roles.includes('SUPER_ADMIN');
  }

  /**
   * (audit C-9) — Assert the loaded report belongs to the
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
    return reports.map((report) => DnaWritingStyleDtoMapper.toReportResponse(report));
  }

  /**
   * Repository-level paginated admin list.
   *
   * Pushes pagination down to the repository (`findPaginated` → `db.findMany` +
   * `db.count`) instead of materializing the full tenant result set and slicing
   * it in the controller. Tenant scope is resolved identically to
   * `getDashboard`/`resolveDashboardScope`: a super admin may target a tenant
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
   * Tenant scoping mirrors `listReports`: a super admin
   * (SUPER_ADMIN) may target a specific tenant via `tenantId`, or
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
   * Mirrors `resolveDashboardScope`, EXCEPT a super admin who supplied no
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
   * Resolve the tenant a dashboard request runs against. Super Admins keep the
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
