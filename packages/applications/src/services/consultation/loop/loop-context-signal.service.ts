import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { HARNESS_LOOP_ENABLED_KEY } from '../consultation-gates.constants';
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
 * No-op when the loop is not enabled for this deployment. The gate is the
 * `harness.loop.enabled` KILL-SWITCH (tier `global-kv`), resolved on EVERY
 * signal through `TenantSettingsService`, so an operator can stop a
 * misbehaving loop with no redeploy (TASK-679).
 *
 * It used to be a plain `HARNESS_LOOP_ENABLED` env read in this constructor,
 * mirroring `OCR_ENABLED`'s posture — and that precedent was itself the
 * configuration-tier violation: §9.2 L1 says an env var is immutable for the
 * process lifetime, so a flag that needs a restart is a build flag, not a
 * kill-switch. A real per-tenant/per-consultation loop POLICY remains a
 * separate concern (`ILoopConfigService`), not a cascade level of this switch.
 *
 * The resolver is `@Optional()`: absent ⇒ the gate reads OFF, which is both the
 * fail-safe answer and the descriptor's declared default.
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
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
  ) {}

  /**
   * The live kill-switch. Read PER CALL, never cached on the instance — that is
   * the whole point of the `global-kv` tier: a `GlobalSetting` write publishes
   * on `app-settings:invalidate` and this node's next signal sees the new value.
   *
   * `resolvePlatform` is the platform lane (`maxScope: 'system'`) and is
   * synchronous — it reads the in-memory settings cache and does no I/O, so it
   * is safe on this per-event path. A backend error propagates rather than
   * being disguised as the default, exactly as `SettingFailMode` requires.
   */
  private get loopEnabled(): boolean {
    if (!this.tenantSettings) return false;
    return this.tenantSettings.resolvePlatform<boolean>(HARNESS_LOOP_ENABLED_KEY).value === true;
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
