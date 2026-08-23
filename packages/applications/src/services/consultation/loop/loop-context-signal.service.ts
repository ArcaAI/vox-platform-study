import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationRepository } from '@arcaai/domains';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { HARNESS_LOOP_EMERGENCY_STOP_KEY } from '../consultation-gates.constants';
import { tenantWorkflowGoverns } from '../governing-engine';
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
 * ─── SUBSTRATE EXCLUSIVITY (TASK-795) ───────────────────────────────────────
 *
 * A THIRD, orthogonal question joins the two above: is this consultation already
 * governed by a tenant-authored `consultation`-palette graph running on the
 * `WorkflowInterpreter` (Substrate B)? That graph's `consultation.persistDraft`
 * node calls the SAME `persist_draft` activity `HarnessDocWorkflow` (Substrate A)
 * uses, so running both means two uncoordinated writers on one document.
 *
 *     signals(consultation) ⇔ entitled(tenant)
 *                             AND NOT emergencyStop
 *                             AND NOT tenantWorkflowGoverns(consultation)
 *
 * The answer is read from a DURABLE marker written at consultation open, so it
 * survives a restart and holds in any process. Unlike the two gates above, this
 * one fails OPEN — see `standDownForTenantWorkflow` for why the directions differ.
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

  /**
   * Bounded, per-consultation cache of the DETERMINATE governing-engine answer
   * (TASK-795 W1). `TRANSCRIPT` is on the `ContextAdded` bus, so `handleContextAdded`
   * runs roughly per utterance; without this the gate would add a row read to every
   * one of them. Caching is sound because the decision is written ONCE, at open,
   * before the consultation id has even been returned to the client — so no signal
   * can precede it and a cached answer can never go stale.
   *
   * INDETERMINATE answers (a throwing read) are deliberately NOT cached: a DB blip
   * must not pin a consultation to the wrong engine for the rest of its life.
   */
  private readonly governedByTenantWorkflow = new Map<string, boolean>();

  constructor(
    private readonly harnessGatewayService: HarnessGatewayService,
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    @Optional() @Inject(ClsService) private readonly clsService?: ClsService<IActiveUserContext>,
    // TASK-795 W1 — reads the durable governing-engine marker written at consultation
    // open. `@Optional()` matches this file's existing convention; absent ⇒ the gate is
    // inert and Substrate A runs, which is this gate's declared FAIL-SAFE direction (see
    // `standDownForTenantWorkflow`). `LiveDocumentationServiceModule` — the one module
    // that provides this service — imports `CoreDatabaseModule`, and
    // `substrate-exclusivity.di-wiring.test.ts` pins that so the gate cannot go silently
    // inert the way `IGateEditExemplarRetriever` did.
    @Optional() @Inject(ConsultationRepository) private readonly consultationRepository?: ConsultationRepository,
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
   * SUBSTRATE EXCLUSIVITY (TASK-795 W1) — `true` when a tenant-authored
   * `consultation`-palette graph already governs this consultation, in which case
   * Substrate A must stand down.
   *
   * ─── WHY A PERSISTED MARKER ─────────────────────────────────────────────────
   *
   * The decision is taken once, at consultation OPEN, by
   * `ConsultationWorkflowDispatchService`. It has to be re-readable on a LATER
   * signal, in ANOTHER process, after a restart — so it is durable state on the
   * consultation row, not a recomputed lookup. It cannot be a `WorkflowRun` query:
   * that table has no consultation linkage to join on (see `governing-engine.ts`).
   *
   * ─── WHY THIS FAILS OPEN WHILE THE ENTITLEMENT GATE FAILS CLOSED ────────────
   *
   * The three DENY answers above are fail-CLOSED because an unresolvable
   * COMMERCIAL gate must not hand out a paid feature — the cost of being wrong is
   * a degraded loop on an unaffected consultation.
   *
   * This gate is the opposite. Being wrong in the "suppress" direction means
   * Substrate A stands down for a consultation Substrate B is NOT actually running,
   * leaving the encounter with NO documentation at all — clinically worse than one
   * documented by the default engine. So an absent marker, a missing row, an
   * unwired repository and a THROWING read are all "Substrate A governs". Only a
   * well-formed, positively-read marker suppresses it.
   *
   * The residual this leaves is bounded and deliberate: if Substrate B genuinely IS
   * running and this read fails, both engines write for that window. That is the
   * lesser of the two harms, and it is the direction the owner brief names.
   */
  private async standDownForTenantWorkflow(consultationId: string): Promise<boolean> {
    if (!this.consultationRepository) return false;

    const cached = this.governedByTenantWorkflow.get(consultationId);
    if (cached !== undefined) return cached;

    let governs: boolean;
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      governs = tenantWorkflowGoverns(consultation?.metadata);
    } catch (error) {
      // NOT cached — see the field doc. Retried on the next signal.
      this.logger.warn({
        message: 'Governing-engine marker could not be read — defaulting to the built-in loop so the consultation is still documented',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    this.trackGovernance(consultationId, governs);
    if (governs) {
      this.logger.log({
        message: 'Loop signal suppressed — a tenant-authored workflow governs this consultation (substrate exclusivity)',
        consultationId,
      });
    }
    return governs;
  }

  /**
   * The composition rule, in one place: emergency stop first (it short-circuits
   * and costs no I/O), then the tenant's subscription entitlement, then substrate
   * exclusivity.
   *
   * Exclusivity is resolved LAST because it is the only per-CONSULTATION read; the
   * two gates before it are per-platform and per-tenant, so a stopped platform or
   * an unentitled tenant never pays for a row read.
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

    let entitled: boolean;
    try {
      entitled = await this.entitlements.isFeatureEnabled(tenantId, 'agenticLoop');
    } catch (error) {
      this.logger.error({
        message: 'Loop signal suppressed — the agenticLoop entitlement could not be resolved',
        consultationId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (!entitled) return false;

    return !(await this.standDownForTenantWorkflow(consultationId));
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

  /** Same bounded-FIFO discipline as {@link trackSignalled}. */
  private trackGovernance(consultationId: string, governs: boolean): void {
    this.governedByTenantWorkflow.set(consultationId, governs);
    if (this.governedByTenantWorkflow.size > LoopContextSignalService.MAX_TRACKED) {
      const oldest = this.governedByTenantWorkflow.keys().next().value;
      if (oldest !== undefined) this.governedByTenantWorkflow.delete(oldest);
    }
  }
}
