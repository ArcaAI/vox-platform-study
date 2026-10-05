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
  HarnessAuditAction,
  JsonValue,
  ResourceType,
} from '@arcaai/domains';
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

/** One approved item, by reference only — never content. */
export interface ApprovalSnapshotItem {
  contextItemId: string;
  type: string;
  versionNumber: number;
  encounterSeq: number | null;
}

export interface ApprovalSnapshot {
  items: ApprovalSnapshotItem[];
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

    const createdBy = actor.principalId || approvedBy;
    const lateMeta = lateSignOff ? { lateSignOff: true, fromStatus } : undefined;

    const write = async (tx?: unknown) => {
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

    return this.respond(updated);
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
