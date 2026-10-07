import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  ConsultationApprovalFactory,
  ConsultationApprovalRepository,
  ConsultationEncounterRepository,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationRepository,
  ConsultationStatus,
  ContextItemRepository,
  ContextItemVersionRepository,
  CoreUnitOfWorkService,
  GuardrailNoticeRepository,
  GuardrailNoticeStatus,
  HarnessAuditAction,
  JsonValue,
  ResourceType,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { isGuardrailHoldReason, type GuardrailHoldResolution, type GuardrailNoticeAcknowledgement } from '@arcaai/types';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HarnessAuditService } from '../../harness-audit';
import { ConsultationDtoMapper } from '../consultation/consultation.dto.mapper';
import type { ConsultationResponse } from '../consultation/dto/consultation.response';
import type { ClinicalCaller } from './IConsultationLifecycleService';
import { IConsultationEncounterService, IConsultationEncounterServiceToken } from '../encounter/IConsultationEncounterService';
import { LifecycleConflictCode, applyLifecycleTransition, lifecycleConflict } from './lifecycle-errors';
import { ConsultationLifecycleEventPublisher } from './lifecycle-event.publisher';
import { SESSION_NOTE_SIGNER, type PreparedSessionSignature, type SessionNoteSigner, type SessionSignerCaller } from './session-note-signer';
import { GUARDRAIL_CONFLICT_CODES, assertResolutionAllowed, guardrailConflict, isRedactionHoldNotice } from '../../guardrail-notice/guardrail-hold.rules';
import { acknowledgementOf, isBlockNotice } from '../../guardrail-notice/guardrail-wire';

/** One approved item, by reference only — never content. */
export interface ApprovalSnapshotItem {
  contextItemId: string;
  type: string;
  versionNumber: number;
  encounterSeq: number | null;
}

export interface ApprovalSnapshot {
  items: ApprovalSnapshotItem[];
  /**
   * TASK-1050 §9.8.3 — the guardrail notices this approval acknowledged (or whose inbound hold it
   * resolved), sorted. Present only when there is at least one, so a snapshot with no guardrail
   * outcome hashes exactly as before.
   */
  guardrailNotices?: string[];
}

/** SHA-256 over the canonical snapshot (items sorted by id, fixed key order). */
export function computeSnapshotHash(snapshot: ApprovalSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export interface ApproveOptions {
  expectedVersion: number;
  clinicianUserId?: string;
  overrideSafetyFlag?: boolean;
  caller: ClinicalCaller;
  legacyContextItemId?: string;
  /** TASK-1050 §9.8.3 — the client showed the warnings; either way every open warning is acknowledged. */
  acknowledgeGuardrailNotices?: boolean;
  /** TASK-1050 §9.8.3 / OD-24 — resolve an INBOUND guardrail hold and approve in the same transaction. */
  resolveHold?: GuardrailHoldResolution;
}

/** What approve does with the consultation's guardrail notices, decided before anything is written. */
interface GuardrailApprovalPlan {
  warnings: GuardrailNoticeEntity[];
  resolve: { notice: GuardrailNoticeEntity; resolution: GuardrailHoldResolution['resolution'] } | null;
  /** The processing marker still says GUARDRAIL_HOLD: the approve write clears it. */
  clearHold: boolean;
}

const APPROVAL_BLOCKING_PROCESSING: ReadonlySet<ConsultationProcessing> = new Set([
  ConsultationProcessing.FINALIZING_TRANSCRIPT,
  ConsultationProcessing.SUMMARIZING,
]);

/** The pinned controller-side caller, in the attribution form the signing core reads. */
export function toSignerCaller(caller: ClinicalCaller | undefined): SessionSignerCaller | undefined {
  // No credential named (an in-process caller): the signing core derives it from the request context.
  if (!caller || (!caller.userId && !caller.serviceAccountId && !caller.apiKeyId)) return undefined;
  if (caller.serviceAccountId) return { credentialClass: 'service-account', principalId: caller.serviceAccountId };
  if (caller.apiKeyId) return { credentialClass: 'api-key', principalId: caller.apiKeyId, boundUserId: caller.userId ?? null };
  return { credentialClass: 'jwt', principalId: caller.userId ?? '' };
}

/**
 * Session approve — ONE approval of the whole consultation record.
 *
 * The clinician attests the record as it stands: every item's current version is pinned in an
 * immutable `ConsultationApproval` snapshot (ids and version numbers only) and its hash, and the
 * consultation locks (`APPROVED`). The consultation's final note, when it has one, is signed in
 * the same act through the summary service's signing core, which keeps the note-level rules
 * (clinician attribution, the safety-flag stop, the draft→signed delta) and the post-sign
 * hand-offs (harness approval signal, governing-run review release, gate-edit mining, DNA
 * capture).
 *
 * Write order: the note version, the note and consultation compare-and-sets, the approval row
 * and the WORM rows (`ATTEST`, `SESSION_APPROVED`, plus the override / before-assurance
 * annotations) share one transaction. The WORM appends run last inside it, so a failed append
 * rolls the approval back (fail-closed) and a refused compare-and-set never leaves an ATTEST
 * behind. Events and hand-offs run only after the commit.
 *
 * - Refused while the transcript is finalizing or the note is being written (409
 *   `CONSULTATION_PROCESSING_IN_FLIGHT`); from OPEN / RECORDING / PAUSED (409
 *   `CONSULTATION_TRANSITION_ILLEGAL`).
 * - APPROVED and CLOSED_COMPLETE: idempotent no-op — a retried Copy to EMR never fails (D-29).
 * - CLOSED_INCOMPLETE: a late sign-off (D-26) — reopened, approved and closed in ONE write, ending
 *   CLOSED_COMPLETE, and recorded as such on the approval row and the WORM trail.
 */
@Injectable()
export class ConsultationApprovalService extends BaseService {
  private readonly logger = new Logger(ConsultationApprovalService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly encounterRepository: ConsultationEncounterRepository,
    private readonly approvalRepository: ConsultationApprovalRepository,
    private readonly harnessAuditService: HarnessAuditService,
    @Inject(SESSION_NOTE_SIGNER) private readonly noteSigner: SessionNoteSigner,
    private readonly events: ConsultationLifecycleEventPublisher,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so direct-construction fixtures build; unwired ⇒ the writes run in sequence.
    @Optional() @Inject(CoreUnitOfWorkService) private readonly unitOfWork?: CoreUnitOfWorkService,
    // The episode facts a consultation response carries; unwired ⇒ the row alone.
    @Optional()
    @Inject(IConsultationEncounterServiceToken)
    private readonly encounterService?: Pick<IConsultationEncounterService, 'lifecycleView'>,
    // TASK-1050 — the consultation's guardrail notices. Unwired ⇒ approve sees no guardrail outcome.
    @Optional() @Inject(GuardrailNoticeRepository) private readonly guardrailNotices?: Pick<GuardrailNoticeRepository, 'findAll' | 'updateWithVersion'>,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async approve(consultationId: string, options: ApproveOptions): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) {
      throw new NotFoundException('Consultation not found');
    }
    // Existence before legality: the per-summary route names a note, and an unknown, foreign or
    // other-consultation note is 404 whatever state the consultation is in.
    if (options.legacyContextItemId !== undefined) {
      await this.assertLegacyNoteInScope(consultationId, tenantId, options.legacyContextItemId);
    }

    if (consultation.status === ConsultationStatus.APPROVED || consultation.status === ConsultationStatus.CLOSED_COMPLETE) {
      return this.respond(consultation);
    }

    const lateSignOff = consultation.status === ConsultationStatus.CLOSED_INCOMPLETE;
    if (APPROVAL_BLOCKING_PROCESSING.has(consultation.processing)) {
      throw lifecycleConflict(
        LifecycleConflictCode.PROCESSING_IN_FLIGHT,
        `The consultation cannot be approved while processing is ${consultation.processing}.`,
        { processing: consultation.processing },
      );
    }
    if (!lateSignOff && !consultation.canTransitionTo(ConsultationStatus.APPROVED)) {
      // Raises the coded 409 the matrix answers for this pair.
      applyLifecycleTransition(consultation, ConsultationStatus.APPROVED, 'approve', 'approve');
    }

    // TASK-1050 — warnings never block; a hold does unless `resolveHold` resolves it (inbound only).
    const guardrail = await this.planGuardrail(consultation, tenantId, options);

    // The per-summary route's If-Match is the NOTE's; the consultation is then compare-and-set on
    // the version just read. The session route's If-Match is the consultation's.
    const legacy = options.legacyContextItemId !== undefined;
    const consultationExpectedVersion = legacy ? consultation.version : options.expectedVersion;

    const prepared = await this.noteSigner.prepareSessionSignature({
      tenantId,
      consultationId,
      legacyContextItemId: options.legacyContextItemId,
      clinicianUserId: options.clinicianUserId,
      caller: toSignerCaller(options.caller),
      overrideSafetyFlag: options.overrideSafetyFlag,
    });
    const { approvedBy, actor, note } = prepared;

    const snapshot = await this.buildSnapshot(consultationId, prepared);
    const guardrailNoticeIds = [...guardrail.warnings.map((notice) => notice.id), ...(guardrail.resolve ? [guardrail.resolve.notice.id] : [])].sort();
    if (guardrailNoticeIds.length > 0) snapshot.guardrailNotices = guardrailNoticeIds;
    const snapshotHash = computeSnapshotHash(snapshot);
    const encounterCount = (await this.encounterRepository.findByConsultation(consultationId)).length || consultation.currentEncounterSeq;
    const approvedAt = new Date();
    const attestationHash = createHash('sha256').update(`${consultationId}:${snapshotHash}:${approvedBy}:${approvedAt.toISOString()}`).digest('hex');

    const fromStatus = consultation.status;
    if (lateSignOff) {
      // The matrix has no CLOSED_INCOMPLETE → APPROVED edge. A late sign-off walks the two legal
      // edges around the one it lacks — reopen, then APPROVED → CLOSED_COMPLETE — and sets APPROVED
      // in between directly. Only the final state is ever persisted.
      applyLifecycleTransition(consultation, ConsultationStatus.OPEN, approvedBy, 'late_sign_off');
      consultation.status = ConsultationStatus.APPROVED;
      consultation.approvedAt = approvedAt;
      consultation.clearDegradedReasons();
      applyLifecycleTransition(consultation, ConsultationStatus.CLOSED_COMPLETE, approvedBy, 'late_sign_off');
    } else {
      applyLifecycleTransition(consultation, ConsultationStatus.APPROVED, approvedBy, 'approve');
      consultation.approvedAt = approvedAt;
    }
    consultation.updatedBy = approvedBy;
    if (guardrail.clearHold) consultation.setProcessing(ConsultationProcessing.IDLE);

    const createdBy = actor.principalId || approvedBy;
    const lateMeta = lateSignOff ? { lateSignOff: true, fromStatus } : undefined;

    const write = async (tx?: unknown) => {
      await this.applyGuardrailPlan(guardrail, { tenantId, consultationId, approvedBy, createdBy, approvedAt }, tx);
      if (note?.version) {
        await this.contextItemVersionRepository.create(note.version, tx);
        await this.contextItemRepository.updateWithVersion(
          note.contextItem.id,
          note.contextItem,
          legacy ? options.expectedVersion : note.contextItem.version,
          tx,
        );
      }
      const updated = await this.consultationRepository.updateWithVersion(consultationId, consultation, consultationExpectedVersion, tx);

      const approval = ConsultationApprovalFactory.CreateConsultationApproval({
        tenantId,
        consultationId,
        approvedBy,
        approvedAt,
        consultationVersion: updated.version,
        encounterCount,
        snapshot: snapshot as unknown as JsonValue,
        snapshotHash,
        attestationHash,
        metaData: lateMeta,
        createdBy,
      });
      const savedApproval = await this.approvalRepository.create(approval, tx);

      await this.appendAuditTrail({
        tenantId,
        consultationId,
        approvedBy,
        createdBy,
        prepared,
        sessionAttestationHash: attestationHash,
        approvalId: savedApproval?.id ?? approval.id,
        snapshotHash,
        itemCount: snapshot.items.length,
        lateMeta,
      });
      return updated;
    };

    const updated = this.unitOfWork ? await this.unitOfWork.runInTransaction((tx) => write(tx)) : await write();

    if (lateSignOff) {
      this.logger.log({ message: 'Late sign-off on an incomplete-closed consultation: reopened, approved and closed', consultationId });
    }

    await this.events.publish(updated, 'approved', { userId: approvedBy });
    if (lateSignOff) {
      await this.events.publish(updated, 'closed', { userId: approvedBy });
    }
    await this.noteSigner.afterSessionSigned({ tenantId, consultation: updated, note, approvedBy, actor });

    const response = await this.respond(updated);
    const acknowledgedNotices = guardrail.warnings
      .map((notice) => acknowledgementOf(notice))
      .filter((ack): ack is GuardrailNoticeAcknowledgement => ack !== null);
    return Object.assign(response, { acknowledgedNotices });
  }

  /**
   * TASK-1050 §9.8.3 — decide, BEFORE anything is written, what approve does with the guardrail
   * notices. Every open warning / unverified notice is acknowledged (never a refusal). An
   * unresolved block — a guardrail hold — is 409 `GUARDRAIL_HOLD` unless `resolveHold` names it and
   * is legal: inbound only (an outbound hold withheld the note, OD-24), `acknowledged` /
   * `item_excluded` only (an edit needs a regenerated note), the override only below a block floor.
   */
  private async planGuardrail(consultation: ConsultationEntity, tenantId: string, options: ApproveOptions): Promise<GuardrailApprovalPlan> {
    const held = consultation.processing === ConsultationProcessing.AWAITING_REVIEW && isGuardrailHoldReason(consultation.processingReason);
    const notices = this.guardrailNotices
      ? await this.guardrailNotices.findAll({
          where: {
            tenantId,
            consultationId: consultation.id,
            status: { in: [GuardrailNoticeStatus.OPEN, GuardrailNoticeStatus.ACKNOWLEDGED] },
          } as never,
          sort: [{ createdAt: 'asc' }, { id: 'asc' }] as never,
        })
      : [];
    const blocks = notices.filter((notice) => isBlockNotice(notice));
    const warnings = notices.filter((notice) => !isBlockNotice(notice) && String(notice.status) === GuardrailNoticeStatus.OPEN);
    // A hold marker with no unresolved block behind it is stale state, never a dead end.
    if (blocks.length === 0) return { warnings, resolve: null, clearHold: held };

    const noticeIds = blocks.map((notice) => notice.id);
    const request = options.resolveHold;
    if (!request) {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.hold, 'The consultation is in a guardrail hold: resolve it (`resolveHold`) or resume it first.', {
        noticeIds,
      });
    }
    const target = blocks.find((notice) => notice.id === request.noticeId);
    if (!target || blocks.length > 1) {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.hold, 'Every guardrail hold but the one approve resolves must be resumed first.', { noticeIds });
    }
    if (String(target.direction) === 'OUTBOUND') {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.hold, 'The generated content was withheld: resume the hold and regenerate the note before approving.', {
        noticeIds,
        reason: 'outbound_hold',
      });
    }
    if (request.resolution === 'item_edited') {
      throw guardrailConflict(GUARDRAIL_CONFLICT_CODES.hold, 'An edited item needs a regenerated note: resume the hold, then approve.', {
        noticeIds,
        reason: 'item_edited',
      });
    }
    assertResolutionAllowed(target, request.resolution);
    return { warnings, resolve: { notice: target, resolution: request.resolution }, clearHold: true };
  }

  /** Inside the approve transaction: acknowledge the warnings, resolve the hold, record an override. */
  private async applyGuardrailPlan(
    plan: GuardrailApprovalPlan,
    context: { tenantId: string; consultationId: string; approvedBy: string; createdBy: string; approvedAt: Date },
    tx: unknown,
  ): Promise<void> {
    if (!this.guardrailNotices) return;
    for (const notice of plan.warnings) {
      notice.acknowledge({ by: context.approvedBy, via: 'approve', at: context.approvedAt });
      await this.guardrailNotices.updateWithVersion(notice.id, notice, notice.version, tx);
    }
    if (!plan.resolve) return;
    const { notice, resolution } = plan.resolve;
    notice.resolve({ by: context.approvedBy, resolution, at: context.approvedAt });
    await this.guardrailNotices.updateWithVersion(notice.id, notice, notice.version, tx);
    if (resolution === 'acknowledged' && !isRedactionHoldNotice(notice)) {
      await this.harnessAuditService.append({
        tenantId: context.tenantId,
        consultationId: context.consultationId,
        action: HarnessAuditAction.SAFETY_OVERRIDE,
        modelName: 'guardrail-hold-override',
        modelVersion: 'v1',
        sensorScores: { noticeId: notice.id, messageKey: notice.messageKey, policyVersion: notice.policyVersion, via: 'approve' } as JsonValue,
        citations: [] as JsonValue,
        clinicianId: context.approvedBy,
        createdBy: context.createdBy,
      });
    }
  }

  private async assertLegacyNoteInScope(consultationId: string, tenantId: string, contextItemId: string): Promise<void> {
    const item = await this.contextItemRepository.findByIdOrNull(contextItemId);
    if (!item || item.tenantId !== tenantId || item.consultationId !== consultationId) {
      throw new NotFoundException('Summary not found');
    }
  }

  private async respond(entity: ConsultationEntity): Promise<ConsultationResponse> {
    const view = this.encounterService ? await this.encounterService.lifecycleView(entity) : undefined;
    return ConsultationDtoMapper.toResponseWithContext(entity, false, view);
  }

  private async buildSnapshot(consultationId: string, prepared: PreparedSessionSignature): Promise<ApprovalSnapshot> {
    const items = await this.contextItemRepository.findByConsultation(consultationId);
    const note = prepared.note;
    const entries: ApprovalSnapshotItem[] = items.map((item) => ({
      contextItemId: item.id,
      type: String(item.type),
      versionNumber: note && item.id === note.contextItem.id ? note.versionNumber : Number(item.currentVersionNumber ?? 0),
      encounterSeq: item.encounterSeq ?? null,
    }));
    entries.sort((a, b) => (a.contextItemId < b.contextItemId ? -1 : a.contextItemId > b.contextItemId ? 1 : 0));
    return { items: entries };
  }

  private async appendAuditTrail(input: {
    tenantId: string;
    consultationId: string;
    approvedBy: string;
    createdBy: string;
    prepared: PreparedSessionSignature;
    sessionAttestationHash: string;
    approvalId: string;
    snapshotHash: string;
    itemCount: number;
    lateMeta?: { lateSignOff: boolean; fromStatus: string };
  }): Promise<void> {
    const note = input.prepared.note;
    const base = {
      tenantId: input.tenantId,
      consultationId: input.consultationId,
      contextItemVersionId: note?.versionId ?? null,
      modelVersion: 'v1',
      citations: [] as JsonValue,
      clinicianId: input.approvedBy,
      // The CREDENTIAL that submitted the row; `clinicianId` is who attested.
      createdBy: input.createdBy,
    };
    const noteHash = note?.attestationHash ?? input.sessionAttestationHash;

    if (note?.safetyOverride) {
      await this.harnessAuditService.append({
        ...base,
        action: HarnessAuditAction.SAFETY_OVERRIDE,
        modelName: 'clinician-override',
        sensorScores: {},
        attestationHash: noteHash,
      });
    }
    await this.harnessAuditService.append({
      ...base,
      action: HarnessAuditAction.ATTEST,
      modelName: 'clinician-attestation',
      sensorScores: {},
      attestationHash: noteHash,
    });
    if (note?.signedBeforeAssurance) {
      await this.harnessAuditService.append({
        ...base,
        action: HarnessAuditAction.SIGNED_BEFORE_ASSURANCE,
        modelName: 'clinician-attestation',
        sensorScores: {},
        attestationHash: noteHash,
      });
    }
    await this.harnessAuditService.append({
      ...base,
      action: HarnessAuditAction.SESSION_APPROVED,
      modelName: 'session-approval',
      sensorScores: {
        approvalId: input.approvalId,
        snapshotHash: input.snapshotHash,
        itemCount: input.itemCount,
        ...(input.lateMeta ?? {}),
      } as JsonValue,
      attestationHash: input.sessionAttestationHash,
    });
  }
}
