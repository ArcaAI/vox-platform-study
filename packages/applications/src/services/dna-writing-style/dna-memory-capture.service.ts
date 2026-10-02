import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConsultationRepository, ContextItemRepository, ContextItemVersionRepository, DnaSampleSource } from '@arcaai/domains';
import { ConfigResolver } from '../config-resolver';
import { DnaMemoryStore } from './dna-memory.store';
import { DNA_MEMORY_CAPTURE_EVENT, DnaMemoryCaptureRequest } from './dna-memory.events';

export type DnaMemoryCaptureOutcome = 'stored' | 'duplicate' | 'skipped' | 'failed';

/**
 * TASK-1034 §4a/§4b — the DNA writing-style MEMORY of a clinician is captured when they update or
 * sign off a generated summary. One sample per capture, for `Consultation.doctorId` (whose note it
 * is — an administrator signing on a clinician's behalf does not make the writing theirs), only
 * while the effective DNA decision (tenant graph AND the doctor's opt-in) is on.
 *
 * NEVER fails the clinical action: `capture` resolves an outcome and logs; it does not throw.
 */
@Injectable()
export class DnaMemoryCaptureService {
  private readonly logger = new Logger(DnaMemoryCaptureService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly store: DnaMemoryStore,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
  ) {}

  /** The listener for {@link DNA_MEMORY_CAPTURE_EVENT}. Async so the emitter never waits on it. */
  @OnEvent(DNA_MEMORY_CAPTURE_EVENT, { async: true })
  async onCaptureRequested(request: DnaMemoryCaptureRequest): Promise<void> {
    await this.capture(request);
  }

  async capture(request: DnaMemoryCaptureRequest): Promise<DnaMemoryCaptureOutcome> {
    const { tenantId, consultationId, contextItemId } = request;
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      const doctorId = consultation?.doctorId;
      if (!doctorId || consultation.tenantId !== tenantId) return 'skipped';

      // No resolver ⇒ the gate cannot be read ⇒ do not learn (DNA fails closed).
      if (!this.configResolver) return 'skipped';
      const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
      if (!effective) return 'skipped';

      const item = await this.contextItemRepository.findById(contextItemId);
      const text = item?.content ?? '';
      if (!item || item.tenantId !== tenantId || text.trim().length === 0) return 'skipped';

      const drafts = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'ai_draft_v1');
      const aiDraft = drafts?.[0]?.content ?? null;

      const outcome = await this.store.store({
        tenantId,
        doctorId,
        source: request.source as DnaSampleSource,
        text,
        aiDraft: aiDraft && aiDraft !== text ? aiDraft : null,
        writtenAt: new Date(),
        kind: 'CASE_NOTE',
        consultationId,
        contextItemId,
        createdBy: doctorId,
      });
      return outcome.stored ? 'stored' : 'duplicate';
    } catch (error) {
      // Ids only — never the text.
      this.logger.warn({
        message: 'DNA memory capture failed (best-effort; the clinical action is unaffected)',
        tenantId,
        consultationId,
        contextItemId,
        source: request.source,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }
}
