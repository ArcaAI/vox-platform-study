import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ConsultationPipelineEvent, type ContextAddedPayload } from '../events';
import { HarnessGatewayService, type HarnessConsultationEndingSignal, type HarnessLoopCancelSignal } from '../harness/harness-gateway.service';

/**
 * LoopContextSignalService — the new `@OnEvent(ContextAdded)` consumer that
 * signals the `ConsultationLoopWorkflow` (TASK-662), plus (TASK-670) the two
 * lifecycle-boundary signal callers (`signalConsultationEnding`,
 * `signalLoopCancel`) that share its exact gating/best-effort posture.
 *
 * Added exactly like `OcrEnrichmentProcessor`: a new provider registered
 * alongside `LiveDocumentationService` in `LiveDocumentationServiceModule` —
 * no controller or route change.
 *
 * No-op when the loop is not configured for this deployment
 * (`HARNESS_LOOP_ENABLED` unset/false — mirrors `OCR_ENABLED`'s plain
 * env-flag posture; a real per-tenant/per-consultation loop policy is
 * TASK-659/662's job, not this ticket's).
 *
 * Idempotent under duplicate emission: `OcrEnrichmentProcessor` re-emits
 * `ContextAdded` for the SAME `contextItemId` once OCR text lands, and any
 * other at-least-once redelivery of an IDENTICAL payload must not
 * double-signal the workflow. Tracked by a small bounded in-memory set keyed
 * on `(consultationId, contextItemId, timestamp)` — the same three fields
 * that make two emissions "the same event" rather than "new content
 * arrived" (a re-emit with fresh content carries a new `timestamp`, so it is
 * correctly treated as a NEW signal, not a duplicate).
 */
@Injectable()
export class LoopContextSignalService {
  private readonly logger = new Logger(LoopContextSignalService.name);

  /** Bounded de-dup guard so a long-running consultation can't grow this unbounded. */
  private static readonly MAX_TRACKED = 2000;
  private readonly signalled = new Set<string>();

  constructor(
    private readonly harnessGatewayService: HarnessGatewayService,
    private readonly configService: ConfigService,
  ) {}

  private get loopEnabled(): boolean {
    const raw = String(this.configService.get('HARNESS_LOOP_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1';
  }

  @OnEvent(ConsultationPipelineEvent.ContextAdded, { async: true })
  async handleContextAdded(payload: ContextAddedPayload): Promise<void> {
    if (!this.loopEnabled) return;

    const key = `${payload.consultationId}:${payload.contextItemId}:${payload.timestamp}`;
    if (this.signalled.has(key)) return;
    this.trackSignalled(key);

    try {
      await this.harnessGatewayService.signalContextAdded(payload.consultationId, {
        tenantId: payload.tenantId,
        contextItemId: payload.contextItemId,
        contextType: payload.contextType,
        subType: payload.subType,
        contentPreview: payload.contentPreview,
        // TASK-670 — payload completeness: kindKey/occurredAt/depth/content.
        kindKey: payload.kindKey,
        occurredAt: payload.timestamp,
        depth: payload.depth ?? 0,
        content: payload.content,
      });
    } catch (error) {
      // Best-effort — never break the context-add path over a loop-signal hiccup.
      this.logger.warn({
        message: 'Failed to signal loop of new context (best-effort)',
        consultationId: payload.consultationId,
        contextItemId: payload.contextItemId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-670 — tell the loop the recording stopped. Same gate + best-effort
   * posture as `handleContextAdded`; the caller (`ConsultationController
   * .stopRecording`) never awaits a failure into a broken response.
   */
  async signalConsultationEnding(consultationId: string, payload: HarnessConsultationEndingSignal = {}): Promise<void> {
    if (!this.loopEnabled) return;

    try {
      await this.harnessGatewayService.signalConsultationEnding(consultationId, payload);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to signal loop consultation-ending (best-effort)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-670 — tell the loop to stop WITHOUT running its ending actions (the
   * consultation was abandoned). Same gate + best-effort posture.
   */
  async signalLoopCancel(consultationId: string, payload: HarnessLoopCancelSignal = {}): Promise<void> {
    if (!this.loopEnabled) return;

    try {
      await this.harnessGatewayService.signalLoopCancel(consultationId, payload);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to signal loop-cancel (best-effort)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private trackSignalled(key: string): void {
    this.signalled.add(key);
    if (this.signalled.size > LoopContextSignalService.MAX_TRACKED) {
      const oldest = this.signalled.values().next().value;
      if (oldest !== undefined) this.signalled.delete(oldest);
    }
  }
}
