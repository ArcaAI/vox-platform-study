import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BusinessException } from '@arcaai/exceptions';
import {
  ConsultationApprovalEntity,
  ConsultationApprovalRepository,
  ConsultationEncounterEntity,
  ConsultationEncounterFactory,
  ConsultationEncounterRepository,
  ConsultationEntity,
  ConsultationLifecycleErrorCode,
  ConsultationRepository,
  CoreDatabaseService,
  ResourceStatusType,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BaseService, assertEqualTenants } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  isValidTimeZone,
} from '../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import type { EncounterResponse } from '../consultation/dto/encounter.response';
import type { ConsultationApprovalResponse } from '../consultation/dto/consultation.response';
import { EncounterDtoMapper } from './encounter.dto.mapper';
import { EncounterStart, IConsultationEncounterService } from './IConsultationEncounterService';
import {
  CONSULTATION_AUTO_CLOSE_SETTING_KEY,
  CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY,
  ConsultationLifecycleView,
  computeAutoCloseAt,
  readAutoClosePolicy,
} from './lifecycle-view';

/** The lifecycle refusals an encounter append can raise, answered as 409 with their code. */
const APPEND_REFUSALS: ReadonlySet<string> = new Set([
  ConsultationLifecycleErrorCode.ENCOUNTER_CAPTURE_ACTIVE,
  ConsultationLifecycleErrorCode.CONSULTATION_APPROVED,
  ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL,
]);

/** The consultation an included encounter row points at (a raw model or an entity). */
interface IncludedConsultation {
  patientId?: string;
  doctorId?: string;
  resourceStatus?: string;
}

/** The lifecycle settings of one tenant, resolved once per answer. */
interface TenantLifecyclePolicy {
  autoClose: unknown;
  timeZone: string;
  allowClosedCompleteReopen: boolean;
}

@Injectable()
export class ConsultationEncounterService extends BaseService implements IConsultationEncounterService {
  private readonly logger = new Logger(ConsultationEncounterService.name);

  constructor(
    private readonly encounterRepository: ConsultationEncounterRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly approvalRepository: ConsultationApprovalRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional: resolves the auto-close and reopen policies and the tenant time zone. Absent ⇒ no
    // deadline is reported and a CLOSED_COMPLETE consultation reads as not reopenable.
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationEncounter);
  }

  async matchExternalRef(
    tenantId: string,
    externalRef: string,
    owner: { patientId: string; doctorId: string },
  ): Promise<{ own: ConsultationEncounterEntity | null; conflict: boolean }> {
    const sameRef = await this.encounterRepository.findByExternalRef(tenantId, externalRef);
    const live = sameRef.filter((encounter) => {
      const consultation = encounter.Consultation as IncludedConsultation | null | undefined;
      return consultation?.resourceStatus !== ResourceStatusType.DELETED;
    });
    const own =
      live.find((encounter) => {
        const consultation = encounter.Consultation as IncludedConsultation | null | undefined;
        return consultation?.patientId === owner.patientId && consultation?.doctorId === owner.doctorId;
      }) ?? null;
    const conflict = live.some((encounter) => (encounter.Consultation as IncludedConsultation | null | undefined)?.patientId !== owner.patientId);
    return { own, conflict };
  }

  async createConsultation(
    consultation: ConsultationEntity,
    first: EncounterStart,
  ): Promise<{ consultation: ConsultationEntity; encounter: ConsultationEncounterEntity }> {
    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const saved = await this.consultationRepository.create(consultation, tx);
      const encounter = await this.encounterRepository.create(
        ConsultationEncounterFactory.CreateConsultationEncounter({
          tenantId: saved.tenantId,
          consultationId: saved.id,
          seq: saved.currentEncounterSeq,
          visitType: first.visitType,
          externalRef: first.externalRef,
          createdBy: saved.createdBy ?? undefined,
        }),
        tx,
      );
      return { consultation: saved, encounter };
    });
    this.broadcastEncounterCreated(created.encounter);
    return created;
  }

  /**
   * Start the next encounter. `beginNextEncounter` also resets `processing` for it (TASK-1059 RC-10):
   * the previous encounter's note outcome (FAILED, AWAITING_REVIEW, IDLE + NOTE_READY) becomes IDLE and
   * is persisted by the same OCC write; work still in flight is kept. A REAL guardrail hold
   * (AWAITING_REVIEW with GUARDRAIL_HOLD / EGRESS_REDACTION_UNAVAILABLE) is deliberately kept across an
   * append — only a resume or an approve resolves it, so the new encounter starts held.
   */
  async appendEncounter(
    consultation: ConsultationEntity,
    next: EncounterStart & { actor: string },
  ): Promise<{ consultation: ConsultationEntity; encounter: ConsultationEncounterEntity }> {
    const previousSeq = consultation.currentEncounterSeq;
    const expectedVersion = consultation.version;
    let seq: number;
    try {
      seq = consultation.beginNextEncounter(next.actor);
    } catch (error) {
      const code = error instanceof BusinessException ? (error.metadata as { code?: string } | undefined)?.code : undefined;
      if (code && APPEND_REFUSALS.has(code)) {
        throw new ConflictException({ code, message: error instanceof Error ? error.message : String(error), status: consultation.status });
      }
      throw error;
    }
    if (next.actor !== 'system') {
      consultation.updatedBy = next.actor;
    }

    const appended = await this.databaseService.baseClient.$transaction(async (tx) => {
      const updated = await this.consultationRepository.updateWithVersion(consultation.id, consultation, expectedVersion, tx);
      await this.encounterRepository.endEncounter(consultation.id, previousSeq, {}, tx);
      const encounter = await this.encounterRepository.create(
        ConsultationEncounterFactory.CreateConsultationEncounter({
          tenantId: consultation.tenantId,
          consultationId: consultation.id,
          seq,
          visitType: next.visitType,
          externalRef: next.externalRef,
          createdBy: next.actor === 'system' ? undefined : next.actor,
        }),
        tx,
      );
      return { consultation: updated, encounter };
    });
    this.broadcastEncounterCreated(appended.encounter);
    return appended;
  }

  async currentEncounter(consultation: ConsultationEntity): Promise<ConsultationEncounterEntity | null> {
    return this.encounterRepository.findBySeq(consultation.id, consultation.currentEncounterSeq);
  }

  async listForConsultation(consultationId: string): Promise<EncounterResponse[]> {
    const tenantId = this.tenantId;
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation || !tenantId) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });
    return EncounterDtoMapper.toResponses(await this.encounterRepository.findByConsultation(consultationId));
  }

  async lifecycleView(consultation: ConsultationEntity): Promise<ConsultationLifecycleView> {
    const [encounters, approval] = await Promise.all([
      this.encounterRepository.findByConsultation(consultation.id),
      consultation.isApproved ? this.approvalRepository.findLatestByConsultation(consultation.id) : Promise.resolve(null),
    ]);
    return this.buildView(consultation, encounters, approval, this.tenantPolicy(consultation.tenantId));
  }

  async lifecycleViews(consultations: ConsultationEntity[]): Promise<Map<string, ConsultationLifecycleView>> {
    const views = new Map<string, ConsultationLifecycleView>();
    if (consultations.length === 0) return views;
    const approvedIds = consultations.filter((consultation) => consultation.isApproved).map((consultation) => consultation.id);
    const [encounters, approvals] = await Promise.all([
      this.encounterRepository.findByConsultations(consultations.map((consultation) => consultation.id)),
      approvedIds.length > 0
        ? this.approvalRepository.findLatestByConsultations(approvedIds)
        : Promise.resolve(new Map<string, ConsultationApprovalEntity>()),
    ]);
    const encountersOf = new Map<string, ConsultationEncounterEntity[]>();
    for (const encounter of encounters) {
      encountersOf.set(encounter.consultationId, [...(encountersOf.get(encounter.consultationId) ?? []), encounter]);
    }
    const policies = new Map<string, TenantLifecyclePolicy>();
    for (const consultation of consultations) {
      let policy = policies.get(consultation.tenantId);
      if (!policy) {
        policy = this.tenantPolicy(consultation.tenantId);
        policies.set(consultation.tenantId, policy);
      }
      views.set(
        consultation.id,
        this.buildView(consultation, encountersOf.get(consultation.id) ?? [], approvals.get(consultation.id) ?? null, policy),
      );
    }
    return views;
  }

  /** One consultation's view from its already-loaded encounters, latest approval and tenant policy. */
  private buildView(
    consultation: ConsultationEntity,
    encounters: ConsultationEncounterEntity[],
    approval: ConsultationApprovalEntity | null,
    policy: TenantLifecyclePolicy,
  ): ConsultationLifecycleView {
    const autoCloseAt = consultation.isClosed
      ? null
      : computeAutoCloseAt(readAutoClosePolicy(policy.autoClose), {
          lastActivityAt: consultation.lastActivityAt,
          now: new Date(),
          timeZone: policy.timeZone,
        });
    return {
      encounters: EncounterDtoMapper.toResponses(encounters),
      approval: consultation.isApproved ? this.approvalResponse(approval) : null,
      autoCloseAt,
      allowClosedCompleteReopen: policy.allowClosedCompleteReopen,
    };
  }

  /** The lifecycle settings of one tenant, resolved once. */
  private tenantPolicy(tenantId: string): TenantLifecyclePolicy {
    return {
      autoClose: this.setting(CONSULTATION_AUTO_CLOSE_SETTING_KEY, tenantId),
      timeZone: this.timeZone(tenantId),
      allowClosedCompleteReopen: this.setting(CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY, tenantId) === true,
    };
  }

  /** The latest approval while the consultation is approved (APPROVED / CLOSED_COMPLETE); a reopen voids it. */
  private approvalResponse(approval: ConsultationApprovalEntity | null): ConsultationApprovalResponse | null {
    if (!approval) return null;
    const items = (approval.snapshot as { items?: unknown } | null | undefined)?.items;
    return {
      id: approval.id,
      approvedAt: approval.approvedAt.toISOString(),
      approvedBy: approval.approvedBy,
      snapshotHash: approval.snapshotHash,
      itemCount: Array.isArray(items) ? items.length : 0,
    };
  }

  /**
   * A tenant-resolved setting value, or `undefined`. A key the registry does not declare (yet)
   * reads as absent: these values decorate a response and must never fail one.
   */
  private setting(key: string, tenantId: string): unknown {
    if (!this.tenantSettings) return undefined;
    try {
      return this.tenantSettings.resolve<unknown>(key, tenantId).value;
    } catch (error) {
      this.logger.warn({
        message: 'A consultation lifecycle setting could not be resolved — reported as absent',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private timeZone(tenantId: string): string {
    const configured = this.setting(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, tenantId);
    return isValidTimeZone(configured) ? configured : CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
  }

  private broadcastEncounterCreated(encounter: ConsultationEncounterEntity): void {
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: encounter.id,
      createdAt: encounter.createdAt,
      data: { consultationId: encounter.consultationId, seq: encounter.seq },
    });
  }
}
