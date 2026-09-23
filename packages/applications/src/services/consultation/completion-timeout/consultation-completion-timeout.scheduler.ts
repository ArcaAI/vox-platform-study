/**
 * TASK-1001 wave 6 (owner decision 2026-09-23) — the consultation COMPLETION TIMEOUT clock.
 *
 * A consultation is READY TO COMPLETE once recording has stopped and its final note has been
 * persisted. From then it waits for the clinician's approval (ALaaS: Save / Submit) for the tenant's
 * `consultation.session.completionTimeoutMinutes` (tenant → platform → 5); with none, it is closed
 * unsigned (`CLOSED_INCOMPLETE`).
 *
 * Why the gateway holds this clock and not an engine: ArcaAI's consultations are documented by the
 * tenant workflow's own graph (whose review gate ALaaS releases at once), others by the harness
 * document workflow — but EVERY note is persisted through `HarnessInternalService.persistDraft`. So
 * that is where the window starts, whichever engine wrote the note.
 *
 * One pending job per consultation (a fixed job id): a re-finalise after a resumed recording replaces
 * it with a fresh window, and a recording that (re)starts cancels it — the consultation is no longer
 * ready to complete. The job itself decides nothing: when it fires, the lifecycle writer closes the
 * consultation only if it is still waiting (see `HarnessInternalService.closeOnCompletionTimeout`).
 *
 * Never throws: its callers are persisting a clinical note or starting a recording, and a queue
 * outage must cost at most the timeout, never the note or the recording.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobQueue } from '@arcaai/domains';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import {
  CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT,
  CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY,
} from '../../settings-registry/descriptors/consultation-completion.descriptors';

export interface ConsultationCompletionTimeoutJob {
  tenantId: string;
  consultationId: string;
}

/** The ONE pending job a consultation can have. BullMQ custom ids may not contain `:`. */
export function completionTimeoutJobId(consultationId: string): string {
  return `completion-${consultationId}`;
}

@Injectable()
export class ConsultationCompletionTimeoutScheduler {
  private readonly logger = new Logger(ConsultationCompletionTimeoutScheduler.name);

  constructor(
    @InjectQueue(JobQueue.ConsultationCompletionTimeout) private readonly queue: Queue,
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  /** Start (or restart) the completion window. Returns what was scheduled, or null on failure. */
  async schedule(tenantId: string, consultationId: string): Promise<{ timeoutMinutes: number; deadlineAt: string } | null> {
    try {
      const timeoutMinutes = await this.resolveTimeoutMinutes(tenantId);
      await this.removePending(consultationId);
      const delay = timeoutMinutes * 60_000;
      await this.queue.add(JobQueue.ConsultationCompletionTimeout, { tenantId, consultationId } satisfies ConsultationCompletionTimeoutJob, {
        jobId: completionTimeoutJobId(consultationId),
        delay,
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      });
      const deadlineAt = new Date(Date.now() + delay).toISOString();
      this.logger.log({ message: 'Consultation completion timeout scheduled', consultationId, timeoutMinutes, deadlineAt });
      return { timeoutMinutes, deadlineAt };
    } catch (error) {
      this.logger.warn({
        message: 'Could not schedule the consultation completion timeout — the idle sweeps remain the backstop',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The consultation is no longer ready to complete (recording again): drop its pending window. */
  async cancel(consultationId: string): Promise<void> {
    try {
      await this.removePending(consultationId);
    } catch (error) {
      this.logger.warn({
        message: 'Could not cancel the consultation completion timeout — the job re-checks the status when it fires',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removePending(consultationId: string): Promise<void> {
    const pending = await this.queue.getJob(completionTimeoutJobId(consultationId));
    // A job that is already running cannot be removed; it re-reads the status and decides for itself.
    await pending?.remove().catch(() => undefined);
  }

  /** `open-to-default`: an unusable value or a settings outage serves the platform code default. */
  private async resolveTimeoutMinutes(tenantId: string): Promise<number> {
    if (!this.effectiveSettings) return CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT;
    try {
      const { value } = await this.effectiveSettings.resolveEffective(CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY, { tenantId });
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT;
    } catch {
      return CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT;
    }
  }
}
