import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  ConsultationProcessing,
  ConsultationRepository,
  ContextItemRepository,
  CoreUnitOfWorkService,
  GuardrailEvaluationRepository,
  GuardrailItemStatus,
  GuardrailNoticeRepository,
  GuardrailNoticeStatus,
  GuardrailNoticeType,
  HarnessAuditAction,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  type ConsultationEntity,
  type GuardrailNoticeEntity,
  type JsonValue,
} from '@arcaai/domains';
import { GUARDRAIL_HOLD_RESOLUTIONS, isGuardrailHoldReason, type GuardrailNoticeAcknowledgement, type HoldResolution } from '@arcaai/types';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { HarnessAuditService } from '../harness-audit/harness-audit.service';
import { HarnessGatewayService } from '../consultation/harness/harness-gateway.service';
import type { ClinicalCaller } from '../consultation/lifecycle/IConsultationLifecycleService';
import { resolveAttributedActor } from '../consultation/lifecycle/attributed-actor';
import { toSignerCaller } from '../consultation/lifecycle/consultation-approval.service';
import { ConsultationLifecycleEventPublisher } from '../consultation/lifecycle/lifecycle-event.publisher';
import { IConsultationWorkflowDispatchService } from '../consultation/workflow-dispatch/IConsultationWorkflowDispatchService';
import { ConsultationDtoMapper } from '../consultation/consultation/consultation.dto.mapper';
import type { ConsultationResponse } from '../consultation/consultation/dto/consultation.response';
import { IConsultationEncounterService, IConsultationEncounterServiceToken } from '../consultation/encounter/IConsultationEncounterService';
import {
  GUARDRAIL_CONFLICT_CODES,
  assertResolutionAllowed,
  guardrailConflict,
  isRedactionHoldNotice,
  screenedVersionsFor,
} from './guardrail-hold.rules';
import { acknowledgementOf, isBlockNotice, toNoticeView, type GuardrailNoticeView } from './guardrail-wire';
import type { IGuardrailNoticeService } from './IGuardrailNoticeService';

/** How many closed (acknowledged / resolved) notices a list carries beside every open one. */
export const GUARDRAIL_NOTICE_RECENT_LIMIT = 20;

/** `GET consultations/:id/guardrail-notices` — the shape both SDKs read (`GuardrailNoticesResponse`). */
export interface GuardrailNoticeListResult {
  /** Every OPEN notice plus the most recent acknowledged / resolved ones, oldest first. */
  notices: GuardrailNoticeView[];
  /** The notices still awaiting an acknowledgement (status OPEN). */
  unacknowledgedNoticeIds: string[];
}

/** `POST …/guardrail-notices/:noticeId/ack` — the updated notice and its acknowledgement. */
export interface GuardrailNoticeAckResult {
  notice: GuardrailNoticeView;
  acknowledgement: GuardrailNoticeAcknowledgement;
}

export interface GuardrailNoticeCommandOptions {
  /** The consultation version the client read (If-Match). */
  expectedVersion: number | undefined;
  /** The clinician the act is attributed to. REQUIRED for a machine credential (TASK-933). */
  clinicianUserId?: string;
  caller?: ClinicalCaller;
}

/** `signaled`: the paused run re-executes its node; `superseded`: a fresh governing run; `none`: nothing to dispatch. */
export type GuardrailHoldDispatch = 'signaled' | 'superseded' | 'none';

/**
 * `POST …/guardrail-hold/resume` — the consultation lifecycle response the other consultation verbs
 * answer (status / processing / processingReason / version, with its ETag), plus the notice resolved.
 */
export type GuardrailHoldResumeResult = ConsultationResponse & { resolvedNoticeId: string };

/**
 * TASK-1050 W2e — the clinician's half of a guardrail outcome (README §9.7.4, §9.7.5, §9.8.1):
 * reading the consultation's notices, acknowledging one, and resuming a guardrail hold.
 *
 * Every command is attributed to a CLINICIAN, never to a machine (the TASK-933 rule): a machine
 * credential must name one, a human acts for themselves unless an administrator. Both commands
 * carry the consultation's If-Match as a precondition (a stale client is 412) and are audited.
 *
 * Resume (OD-18, §9.8.1): `item_excluded` / `item_edited` are always offered, `acknowledged` (an
 * override recorded as `SAFETY_OVERRIDE`) unless the check's platform floor is block. The notice
 * resolves and — when no other block holds it — processing returns to IDLE, in one transaction.
 * After the commit the run paused on that notice is signalled to re-execute its node; a run that is
 * no longer paused (timed out, `run.failed GUARDRAIL_BLOCKED`) is replaced through the supersede
 * path, so a resume is never a dead end.
 */
@Injectable()
export class GuardrailNoticeService extends BaseService implements IGuardrailNoticeService {
  private readonly logger = new Logger(GuardrailNoticeService.name);

  constructor(
    private readonly consultations: ConsultationRepository,
    private readonly notices: GuardrailNoticeRepository,
    private readonly evaluations: GuardrailEvaluationRepository,
    private readonly contextItems: ContextItemRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: Pick<CoreUnitOfWorkService, 'runInTransaction'>,
    @Optional() @Inject(ConsultationLifecycleEventPublisher) private readonly lifecycleEvents?: Pick<ConsultationLifecycleEventPublisher, 'publish'>,
    @Optional() @Inject(HarnessAuditService) private readonly harnessAudit?: Pick<HarnessAuditService, 'append'>,
    @Optional() @Inject(HarnessGatewayService) private readonly harnessGateway?: Pick<HarnessGatewayService, 'signalGuardrailResolution'>,
    @Optional()
    @Inject(IConsultationWorkflowDispatchService)
    private readonly dispatch?: { supersedeGoverningRun?: IConsultationWorkflowDispatchService['supersedeGoverningRun'] },
    @Optional() private readonly userRoleAssignmentRepository?: UserRoleAssignmentRepository,
    @Optional() private readonly userDepartmentRepository?: UserDepartmentRepository,
    @Optional() private readonly userRepository?: UserRepository,
    // The episode facts the resume's consultation response carries; unwired ⇒ the row alone.
    @Optional()
    @Inject(IConsultationEncounterServiceToken)
    private readonly encounterService?: Pick<IConsultationEncounterService, 'lifecycleView'>,
  ) {
    super(eventEmitter, clsService, ResourceType.GuardrailNotice);
  }

  async list(consultationId: string): Promise<GuardrailNoticeListResult> {
    const consultation = await this.loadConsultation(consultationId);
    const [open, recent] = await Promise.all([
      this.notices.findOpenByConsultation(consultation.tenantId, consultation.id),
      this.notices.findAll({
        where: { tenantId: consultation.tenantId, consultationId: consultation.id, status: { not: GuardrailNoticeStatus.OPEN } } as never,
        sort: [{ updatedAt: 'desc' }, { id: 'desc' }] as never,
        page: 1,
        limit: GUARDRAIL_NOTICE_RECENT_LIMIT,
      }),
    ]);
    const seen = new Set<string>();
    const rows = [...open, ...recent].filter((notice) => !seen.has(notice.id) && seen.add(notice.id));
    rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      notices: rows.map((notice) => toNoticeView(notice)),
      unacknowledgedNoticeIds: rows.filter((notice) => String(notice.status) === GuardrailNoticeStatus.OPEN).map((notice) => notice.id),
    };
  }

  async acknowledge(consultationId: string, noticeId: string, options: GuardrailNoticeCommandOptions): Promise<GuardrailNoticeAckResult> {
    const consultation = await this.loadConsultation(consultationId);
    this.assertVersion(consultation, options.expectedVersion);
    const notice = await this.loadNotice(consultation, noticeId);
    if (String(notice.status) === GuardrailNoticeStatus.RESOLVED) {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.noticeResolved, 'The notice is already resolved.', { noticeId: notice.id });
    }
    const { clinicianId, submittedBy } = await this.resolveActor(consultation, options);
    if (String(notice.status) === GuardrailNoticeStatus.ACKNOWLEDGED) return this.ackResult(notice);

    notice.acknowledge({ by: clinicianId, via: 'notice' });
    const saved = await this.notices.updateWithVersion(notice.id, notice, notice.version, undefined);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: notice.id,
      resourceType: ResourceType.GuardrailNotice,
      forceAuditLog: true,
      data: { action: 'guardrail_notice_acknowledged', consultationId: consultation.id, clinicianId, submittedBy, via: 'notice' },
    });
    return this.ackResult(saved);
  }

  private ackResult(notice: GuardrailNoticeEntity): GuardrailNoticeAckResult {
    return { notice: toNoticeView(notice), acknowledgement: acknowledgementOf(notice)! };
  }

  async resumeHold(
    consultationId: string,
    body: { noticeId: string; resolution: HoldResolution },
    options: GuardrailNoticeCommandOptions,
  ): Promise<GuardrailHoldResumeResult> {
    if (!(GUARDRAIL_HOLD_RESOLUTIONS as readonly string[]).includes(body?.resolution)) {
      throw new BadRequestException(`resolution must be one of ${GUARDRAIL_HOLD_RESOLUTIONS.join(', ')}`);
    }
    const consultation = await this.loadConsultation(consultationId);
    this.assertVersion(consultation, options.expectedVersion);
    const notice = await this.loadNotice(consultation, body.noticeId);
    if (!isBlockNotice(notice)) {
      throw guardrailConflict(
        GUARDRAIL_CONFLICT_CODES.noticeNotResumable,
        'Only a block notice holds a consultation; acknowledge a warning instead.',
        {
          noticeId: notice.id,
        },
      );
    }
    if (String(notice.status) === GuardrailNoticeStatus.RESOLVED) {
      if (notice.resolution === body.resolution) return this.resumeResult(consultation, notice.id);
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.noticeResolved, `The notice is already resolved as ${notice.resolution}.`, {
        noticeId: notice.id,
        resolution: notice.resolution,
      });
    }
    assertResolutionAllowed(notice, body.resolution);
    const { clinicianId, submittedBy } = await this.resolveActor(consultation, options);
    const edited = body.resolution === 'item_edited' ? await this.editedItems(consultation, notice) : [];

    const otherBlocks = await this.notices.findAll({
      where: {
        tenantId: consultation.tenantId,
        consultationId: consultation.id,
        type: GuardrailNoticeType.BLOCKED,
        status: { in: [GuardrailNoticeStatus.OPEN, GuardrailNoticeStatus.ACKNOWLEDGED] },
        id: { not: notice.id },
      } as never,
    });
    const held = consultation.processing === ConsultationProcessing.AWAITING_REVIEW && isGuardrailHoldReason(consultation.processingReason);
    const retry = isRedactionHoldNotice(notice);
    const release = held && otherBlocks.length === 0;

    const write = async (tx?: unknown) => {
      notice.resolve({ by: clinicianId, resolution: body.resolution });
      await this.notices.updateWithVersion(notice.id, notice, notice.version, tx);
      if (edited.length > 0) await this.contextItems.setGuardrailStatusMany(edited, GuardrailItemStatus.CLEAN, tx);
      if (release) await this.consultations.setProcessing(consultation.id, ConsultationProcessing.IDLE, { reason: null }, tx);
      // The egress-redaction hold's `acknowledged` is a RETRY, not a safety override (round 4).
      if (body.resolution === 'acknowledged' && !retry) await this.appendOverride(consultation, notice, clinicianId, submittedBy);
    };
    if (this.unitOfWork) await this.unitOfWork.runInTransaction((tx) => write(tx));
    else await write();

    if (release) await this.announceRelease(consultation, notice.id);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: notice.id,
      resourceType: ResourceType.GuardrailNotice,
      forceAuditLog: true,
      data: {
        action: retry ? 'guardrail_hold_retried' : 'guardrail_hold_resumed',
        consultationId: consultation.id,
        resolution: body.resolution,
        ...(retry ? { processingReason: 'EGRESS_REDACTION_UNAVAILABLE' } : {}),
        clinicianId,
        submittedBy,
        released: release,
      },
    });
    const dispatch = await this.dispatchAfterResume(consultation, notice, body.resolution, clinicianId);
    this.logger.log({
      message: 'Guardrail hold resumed',
      consultationId: consultation.id,
      noticeId: notice.id,
      resolution: body.resolution,
      released: release,
      dispatch,
    });
    return this.resumeResult(consultation, notice.id);
  }

  /** The consultation as it stands now (a fresh read: processing moved), in the lifecycle-verb shape. */
  private async resumeResult(fallback: ConsultationEntity, noticeId: string): Promise<GuardrailHoldResumeResult> {
    const current = (await this.consultations.findByIdOrNull(fallback.id)) ?? fallback;
    const view = this.encounterService ? await this.encounterService.lifecycleView(current) : undefined;
    return Object.assign(ConsultationDtoMapper.toResponseWithContext(current, false, view), { resolvedNoticeId: noticeId });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    return tenantId;
  }

  /** The consultation, or 404 when it is unknown or another tenant's. */
  private async loadConsultation(consultationId: string): Promise<ConsultationEntity> {
    const tenantId = this.requireTenant();
    const consultation = await this.consultations.findByIdOrNull(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) throw new NotFoundException(`Consultation ${consultationId} not found`);
    return consultation;
  }

  /** The notice, or 404 unless it is this consultation's (another tenant's id is indistinguishable). */
  private async loadNotice(consultation: ConsultationEntity, noticeId: string): Promise<GuardrailNoticeEntity> {
    const notice = await this.notices.findByIdOrNull(noticeId);
    if (!notice || notice.tenantId !== consultation.tenantId || notice.consultationId !== consultation.id) {
      throw new NotFoundException(`Guardrail notice ${noticeId} not found`);
    }
    return notice;
  }

  /** If-Match on the consultation: a precondition only — neither command bumps the consultation. */
  private assertVersion(consultation: ConsultationEntity, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || expectedVersion !== consultation.version) {
      throw new OptimisticConcurrencyException('consultation', consultation.id, {
        expectedVersion: expectedVersion ?? null,
        currentVersion: consultation.version,
        tenantId: consultation.tenantId,
      } as never);
    }
  }

  private async resolveActor(
    consultation: ConsultationEntity,
    options: GuardrailNoticeCommandOptions,
  ): Promise<{ clinicianId: string; submittedBy: string }> {
    const { clinicianId, caller } = await resolveAttributedActor({
      tenantId: consultation.tenantId,
      named: options.clinicianUserId,
      caller: toSignerCaller(options.caller),
      requestUser: this.clsService.get('user'),
      requestServiceAccount: this.clsService.get('serviceAccount') as { id: string } | undefined,
      repositories: {
        userRoleAssignmentRepository: this.userRoleAssignmentRepository,
        userDepartmentRepository: this.userDepartmentRepository,
        userRepository: this.userRepository,
      },
    });
    return { clinicianId, submittedBy: caller.principalId || clinicianId };
  }

  /** `item_edited`: the flagged items the clinician changed since the blocked screen (409 if none). */
  private async editedItems(consultation: ConsultationEntity, notice: GuardrailNoticeEntity): Promise<string[]> {
    const itemIds = [...(notice.itemIds ?? [])];
    const screened = screenedVersionsFor(notice.id, itemIds, await this.evaluations.findByConsultation(consultation.tenantId, consultation.id));
    const items =
      itemIds.length > 0
        ? ((await this.contextItems.findAll({ where: { id: { in: itemIds } } as never })) as unknown as Array<{
            id: string;
            tenantId: string;
            consultationId?: string | null;
            currentVersionNumber?: number;
          }>)
        : [];
    const edited = items
      .filter((item) => item.tenantId === consultation.tenantId && item.consultationId === consultation.id)
      .filter((item) => {
        const blockedAt = screened.get(item.id);
        return blockedAt !== undefined && Number(item.currentVersionNumber ?? 1) > blockedAt;
      })
      .map((item) => item.id);
    if (edited.length === 0) {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.itemNotEdited, 'No flagged item has been edited since it was blocked.', {
        noticeId: notice.id,
      });
    }
    return edited;
  }

  /** The override is a WORM fact (the existing `SAFETY_OVERRIDE` pattern); a failed append fails the resume. */
  private async appendOverride(
    consultation: ConsultationEntity,
    notice: GuardrailNoticeEntity,
    clinicianId: string,
    submittedBy: string,
  ): Promise<void> {
    if (!this.harnessAudit) {
      throw new Error('A guardrail override must be recorded, but the harness audit trail is not wired');
    }
    await this.harnessAudit.append({
      tenantId: consultation.tenantId,
      consultationId: consultation.id,
      action: HarnessAuditAction.SAFETY_OVERRIDE,
      modelName: 'guardrail-hold-override',
      modelVersion: 'v1',
      sensorScores: {
        noticeId: notice.id,
        messageKey: notice.messageKey,
        policyVersion: notice.policyVersion,
        checks: notice.checks,
      } as unknown as JsonValue,
      citations: [],
      clinicianId,
      createdBy: submittedBy,
    });
  }

  private async announceRelease(consultation: ConsultationEntity, noticeId: string): Promise<void> {
    try {
      await this.lifecycleEvents?.publish(
        {
          id: consultation.id,
          tenantId: consultation.tenantId,
          status: String(consultation.status),
          processing: ConsultationProcessing.IDLE,
          processingReason: null,
          closedReason: consultation.closedReason ?? null,
          currentEncounterSeq: consultation.currentEncounterSeq,
          version: consultation.version,
        },
        'processing_changed',
        { noticeId },
      );
    } catch (error) {
      this.logger.warn({
        message: 'Guardrail hold released, but the lifecycle event was not published',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The run paused on the notice re-executes its node with the resolution; a run that is no longer
   * paused is replaced through the supersede path. A hold raised outside a run (a live summary, a
   * direct generation) dispatches nothing: the next tick re-screens under the resolution.
   */
  private async dispatchAfterResume(
    consultation: ConsultationEntity,
    notice: GuardrailNoticeEntity,
    resolution: HoldResolution,
    clinicianId: string,
  ): Promise<GuardrailHoldDispatch> {
    if (!notice.runId) return 'none';
    if (this.harnessGateway) {
      try {
        await this.harnessGateway.signalGuardrailResolution(
          notice.runId,
          { noticeId: notice.id, resolution, by: clinicianId },
          consultation.tenantId,
        );
        return 'signaled';
      } catch (error) {
        this.logger.warn({
          message: 'The run is no longer paused on the guardrail notice — falling back to the supersede path',
          consultationId: consultation.id,
          runId: notice.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!this.dispatch?.supersedeGoverningRun) return 'none';
    try {
      const result = await this.dispatch.supersedeGoverningRun({
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        triggerId: `guardrail-hold:${notice.id}`,
        userId: clinicianId,
      });
      return result.superseded ? 'superseded' : 'none';
    } catch (error) {
      this.logger.warn({
        message: 'Guardrail hold resumed, but the supersede dispatch failed (the hold is released; a later stop re-finalises)',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'none';
    }
  }
}
