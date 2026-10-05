import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import {
  ConsultationPipelineEvent,
  type ContextAddedPayload,
  type EncounterStoppedPayload,
  type FullTranscriptRebuiltPayload,
} from '../events/consultation.events';
import { FactLedgerService } from './fact-ledger.service';
import { FactLedgerQueue } from './fact-ledger.processor';

/**
 * Turns record events into ledger jobs.
 *
 * - `EncounterStopped` — the encounter's final transcript is in: build its ledger.
 * - `FullTranscriptRebuilt` / a TRANSCRIPT item added (uploaded audio) — re-build only encounters
 *   that already have a ledger whose input digest no longer matches. An encounter still being
 *   recorded has no ledger yet and is left to its own stop.
 *
 * Duplicates (AB-4a and AB-5 may both emit `EncounterStopped`) collapse on the job id, which is
 * keyed by `(consultation, encounter, digest)`. Never throws: the record is already persisted, and
 * a missing ledger only degrades coverage to `unchecked`.
 */
@Injectable()
export class FactLedgerListener {
  private readonly logger = new Logger(FactLedgerListener.name);

  constructor(
    private readonly factLedger: FactLedgerService,
    private readonly queue: FactLedgerQueue,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @OnEvent(ConsultationPipelineEvent.EncounterStopped, { async: true })
  async onEncounterStopped(payload: EncounterStoppedPayload): Promise<void> {
    await this.guarded(payload, 'encounter_stopped', async () => {
      const inputDigest = await this.factLedger.computeEncounterDigest(payload.consultationId, payload.encounterSeq);
      if (!inputDigest) return;
      await this.queue.enqueue({
        tenantId: payload.tenantId,
        consultationId: payload.consultationId,
        encounterSeq: payload.encounterSeq,
        inputDigest,
      });
    });
  }

  @OnEvent(ConsultationPipelineEvent.FullTranscriptRebuilt, { async: true })
  async onFullTranscriptRebuilt(payload: FullTranscriptRebuiltPayload): Promise<void> {
    await this.guarded(payload, 'transcript_rebuilt', () => this.enqueueStale(payload.tenantId, payload.consultationId));
  }

  @OnEvent(ConsultationPipelineEvent.ContextAdded, { async: true })
  async onContextAdded(payload: ContextAddedPayload): Promise<void> {
    if (payload.contextType !== 'TRANSCRIPT') return;
    await this.guarded(payload, 'transcript_added', () => this.enqueueStale(payload.tenantId, payload.consultationId));
  }

  private async enqueueStale(tenantId: string, consultationId: string): Promise<void> {
    for (const { encounterSeq, inputDigest } of await this.factLedger.staleLedgerEncounters(consultationId)) {
      await this.queue.enqueue({ tenantId, consultationId, encounterSeq, inputDigest });
    }
  }

  /** Runs `work` in a tenant-bound CLS scope (the emitter may have none) and swallows every failure. */
  private async guarded(
    payload: { tenantId: string; consultationId: string; userId?: string },
    trigger: string,
    work: () => Promise<void>,
  ): Promise<void> {
    if (!payload?.tenantId || !payload.consultationId) return;
    try {
      await this.cls.run(async () => {
        this.cls.set('tenantId', payload.tenantId);
        this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId: payload.tenantId, kind: 'fact-ledger' }));
        await work();
      });
    } catch (error) {
      this.logger.warn({
        message: 'Fact-ledger enqueue failed — the encounter keeps no ledger until the next trigger',
        consultationId: payload.consultationId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
