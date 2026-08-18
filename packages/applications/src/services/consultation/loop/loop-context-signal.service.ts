import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { HARNESS_LOOP_EMERGENCY_STOP_KEY } from '../consultation-gates.constants';
import { ConsultationPipelineEvent, type ContextAddedPayload } from '../events';
import { HarnessGatewayService, type HarnessConsultationEndingSignal, type HarnessLoopCancelSignal } from '../harness/harness-gateway.service';

/**
 * LoopContextSignalService — the `@OnEvent(ContextAdded)` consumer that
 * signals the `ConsultationLoopWorkflow`, plus the two lifecycle-boundary
 * signal callers (`signalConsultationEnding`, `signalLoopCancel`) that share
 * its exact gating/best-effort posture.
 *
 * Registered alongside `LiveDocumentationService` in
 * `LiveDocumentationServiceModule` — no controller or route change.
 *
 * ─── THE GATE (TASK-705) ────────────────────────────────────────────────────
 *
 * The harness agentic loop is CORE BUSINESS and is packaged as a SUBSCRIPTION
 * FEATURE (owner decision, `owner-decisions-2026-08-17.md` §2 row 705). Two
 * different concerns therefore decide whether a signal leaves this service, and
 * conflating them is what the previous single `harness.loop.enabled`
 * kill-switch got wrong:
 *
 *   ELIGIBILITY — commercial, per tenant, resolved from the DATABASE through
 *     `IEntitlementsService.isFeatureEnabled(tenantId, 'agenticLoop')`
 *     (plan matrix ← plan row ← per-tenant override).
 *   EMERGENCY STOP — operational, platform-wide, resolved per signal from the
 *     `harness.loop.emergencyStop` `global-kv` row so an operator can halt a
 *     misbehaving loop with no redeploy.
 *
 *     signals(tenant) ⇔ entitled(tenant) AND NOT emergencyStop
 *
 * The stop can only ever SUBTRACT: engaging it stops an entitled tenant,
 * disengaging it never grants an unentitled one. Read the AND in that order —
 * the stop short-circuits, so an incident costs no entitlement lookups.
 *
 * Three deliberate DENY answers, each fail-closed for a different reason:
 *
 *   • no tenant identity — eligibility that cannot be established is not
 *     eligibility, and `X-Tenant-Id` is mandatory on tenant-scoped work
 *     (`00-project-context.md` §Tenant identity).
 *   • no entitlements resolver wired — a commercial gate that cannot be read
 *     must not hand out the feature.
 *   • the entitlement read THREW — same reasoning. A DB blip degrades the loop
 *     (Layer 1 live documentation is untouched and the consultation is
 *     unaffected); it must not silently grant a paid capability.
 *
 * The `harness.loop.emergencyStop` resolver is `@Optional()`: absent ⇒ NO stop
 * is engaged. That is the correct direction now that the switch is a veto
 * rather than the eligibility source — an unwired resolver must not
 * impersonate an operator pulling the emergency handle.
 *
 * ─── IDEMPOTENCE ────────────────────────────────────────────────────────────
 *
 * `OcrEnrichmentProcessor` re-emits `ContextAdded` for the SAME `contextItemId`
 * once OCR text lands, and any other at-least-once redelivery of an IDENTICAL
 * payload must not double-signal the workflow. Tracked by a small bounded
 * in-memory set keyed on `(consultationId, contextItemId, timestamp)` — the
 * same three fields that make two emissions "the same event" rather than "new
 * content arrived" (a re-emit with fresh content carries a new `timestamp`, so
 * it is correctly treated as a NEW signal, not a duplicate).
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
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    @Optional() @Inject(ClsService) private readonly clsService?: ClsService<IActiveUserContext>,
  ) {}

  /**
   * The live platform veto. Read PER CALL, never cached on the instance — that
   * is the whole point of the `global-kv` tier: a `GlobalSetting` write
   * publishes on `app-settings:invalidate` and this node's next signal sees the
   * new value.
   *
   * `resolvePlatform` is the platform lane (`maxScope: 'system'`) and is
   * synchronous — it reads the in-memory settings cache and does no I/O, so it
   * is safe on this per-event path. `maxScope: 'system'` also means the tenant
   * lane is never consulted, so a row planted under a customer tenant can never
   * govern this key. A backend error propagates rather than being disguised as
   * the default, exactly as `SettingFailMode` requires.
   */
  private get emergencyStopEngaged(): boolean {
    if (!this.tenantSettings) return false;
    return this.tenantSettings.resolvePlatform<boolean>(HARNESS_LOOP_EMERGENCY_STOP_KEY).value === true;
  }

  /**
   * The composition rule, in one place: emergency stop first (it short-circuits
   * and costs no I/O), then the tenant's subscription entitlement.
   */
  private async loopAllowedFor(tenantId: string | null | undefined, consultationId: string): Promise<boolean> {
    if (this.emergencyStopEngaged) return false;

    if (!tenantId) {
      this.logger.warn({
        message: 'Loop signal suppressed — no tenant identity, so the subscription entitlement cannot be resolved',
        consultationId,
      });
      return false;
    }

    if (!this.entitlements) {
      this.logger.warn({
        message: 'Loop signal suppressed — no entitlements resolver wired; a commercial gate fails closed',
        consultationId,
        tenantId,
      });
      return false;
    }

    try {
      return await this.entitlements.isFeatureEnabled(tenantId, 'agenticLoop');
    } catch (error) {
      this.logger.error({
        message: 'Loop signal suppressed — the agenticLoop entitlement could not be resolved',
        consultationId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** The request tenant, when this call is running inside a CLS-scoped request. */
  private get contextTenantId(): string | null {
    return this.clsService?.get('tenantId') ?? null;
  }

  @OnEvent(ConsultationPipelineEvent.ContextAdded, { async: true })
  async handleContextAdded(payload: ContextAddedPayload): Promise<void> {
    // The event carries its own tenant explicitly — it may be emitted from a
    // background drain with no CLS scope, so never fall back to the ambient one.
    if (!(await this.loopAllowedFor(payload.tenantId, payload.consultationId))) return;

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
        // Payload completeness: kindKey/occurredAt/depth/content.
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
   * Tell the loop the recording stopped. Same gate + best-effort posture as
   * `handleContextAdded`; the caller (`ConsultationController.stopRecording`)
   * never awaits a failure into a broken response. The tenant comes from CLS —
   * this method is only ever called inside a request scope, and the signal
   * payload has no tenant field of its own.
   */
  async signalConsultationEnding(consultationId: string, payload: HarnessConsultationEndingSignal = {}): Promise<void> {
    if (!(await this.loopAllowedFor(this.contextTenantId, consultationId))) return;

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
   * Tell the loop to stop WITHOUT running its ending actions (the
   * consultation was abandoned). Same gate + best-effort posture.
   */
  async signalLoopCancel(consultationId: string, payload: HarnessLoopCancelSignal = {}): Promise<void> {
    if (!(await this.loopAllowedFor(this.contextTenantId, consultationId))) return;

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
