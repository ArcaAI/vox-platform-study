import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ConsultationEntity, ConsultationProcessing, ConsultationRepository, ConsultationStatus } from '@arcaai/domains';
import type { ConsultationProcessing as WireProcessing } from '@arcaai/types';
import { IActiveUserContext } from '../../../interfaces';
import { IConsultationLifecycleGate } from './IConsultationLifecycleService';
import { LifecycleConflictCode, lifecycleConflict } from './lifecycle-errors';
import { ConsultationLifecycleEventPublisher } from './lifecycle-event.publisher';

/**
 * The narrow lifecycle surface other services call: the content lock, the activity clock and the
 * `processing` axis. Nothing here bumps the consultation `_version` — `processing` and
 * `lastActivityAt` churn constantly, and a client's If-Match must survive it — so every write goes
 * through the repository's no-version-bump writers, never `updateWithVersion`.
 *
 * `processingRefs` lets several pieces of background work share one marker (two attachments
 * processing at once): `beginProcessing` adds a ref and remembers the marker it displaced
 * (`processingPrior`); `endProcessing` removes it and, when the last ref ends, restores that
 * marker. The read-modify-write is not serialised — two concurrent begin/end calls on one
 * consultation can lose a ref, which a later `setProcessing` or the next begin/end repairs.
 */
@Injectable()
export class ConsultationLifecycleGate extends IConsultationLifecycleGate {
  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly events: ConsultationLifecycleEventPublisher,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super();
  }

  async assertContentWritable(consultationId: string): Promise<void> {
    const consultation = await this.load(consultationId);
    if (consultation.status === ConsultationStatus.APPROVED || consultation.status === ConsultationStatus.CLOSED_COMPLETE) {
      throw lifecycleConflict(LifecycleConflictCode.CONSULTATION_APPROVED, 'The consultation is approved; its content is locked.', {
        status: consultation.status,
      });
    }
    if (consultation.status === ConsultationStatus.CLOSED_INCOMPLETE) {
      throw lifecycleConflict(LifecycleConflictCode.CONSULTATION_CLOSED, 'The consultation is closed; reopen it before changing its content.', {
        status: consultation.status,
      });
    }
  }

  async touchActivity(consultationId: string): Promise<void> {
    await this.consultationRepository.touchActivity(consultationId);
  }

  async beginProcessing(consultationId: string, processing: WireProcessing, refId: string): Promise<void> {
    const consultation = await this.load(consultationId);
    const next = processing as ConsultationProcessing;
    const refs = consultation.processingRefs.includes(refId) ? consultation.processingRefs : [...consultation.processingRefs, refId];
    if (consultation.processing === next) {
      await this.consultationRepository.setProcessing(consultationId, next, { refs });
      return;
    }
    await this.consultationRepository.setProcessing(consultationId, next, { refs, prior: consultation.processing });
    await this.announce(consultation, next, null);
  }

  async endProcessing(consultationId: string, refId: string, outcome: { failed?: boolean; reason?: string } = {}): Promise<void> {
    const consultation = await this.load(consultationId);
    const refs = consultation.processingRefs.filter((ref) => ref !== refId);

    if (outcome.failed) {
      const reason = outcome.reason ?? null;
      await this.consultationRepository.setProcessing(consultationId, ConsultationProcessing.FAILED, { reason, refs, prior: null });
      if (consultation.processing !== ConsultationProcessing.FAILED) {
        await this.announce(consultation, ConsultationProcessing.FAILED, reason);
      }
      return;
    }

    if (refs.length > 0) {
      await this.consultationRepository.setProcessing(consultationId, consultation.processing, { refs });
      return;
    }

    const restored = consultation.processingPrior ?? ConsultationProcessing.IDLE;
    await this.consultationRepository.setProcessing(consultationId, restored, { refs: [], prior: null });
    if (consultation.processing !== restored) {
      await this.announce(consultation, restored, null);
    }
  }

  async setProcessing(consultationId: string, processing: WireProcessing, reason?: string): Promise<void> {
    const consultation = await this.load(consultationId);
    const next = processing as ConsultationProcessing;
    await this.consultationRepository.setProcessing(consultationId, next, { reason: reason ?? null });
    // A reason change on an unchanged value is still a change a client must see (a note written
    // on an already-IDLE consultation, a new gap count). Compared after the domain's reason rule,
    // so a reason the writer drops is not announced.
    const reasonChanged = ConsultationEntity.processingReasonFor(next, reason) !== (consultation.processingReason ?? null);
    if (consultation.processing !== next || reasonChanged) {
      await this.announce(consultation, next, reason ?? null);
    }
  }

  async currentEncounterSeq(consultationId: string): Promise<number> {
    return (await this.load(consultationId)).currentEncounterSeq;
  }

  /**
   * The row, inside the caller's tenant. Without a CLS tenant (a platform-wide worker) the row is
   * read as is — the caller is then trusted to have scoped the id.
   */
  private async load(consultationId: string): Promise<ConsultationEntity> {
    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    const tenantId = this.clsService.get('tenantId') || null;
    if (!consultation || (tenantId && consultation.tenantId !== tenantId)) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }

  private async announce(consultation: ConsultationEntity, processing: ConsultationProcessing, reason: string | null): Promise<void> {
    await this.events.publish(
      {
        id: consultation.id,
        tenantId: consultation.tenantId,
        status: consultation.status,
        processing,
        processingReason: ConsultationEntity.processingReasonFor(processing, reason),
        closedReason: consultation.closedReason,
        currentEncounterSeq: consultation.currentEncounterSeq,
        version: consultation.version,
      },
      'processing_changed',
    );
  }
}
