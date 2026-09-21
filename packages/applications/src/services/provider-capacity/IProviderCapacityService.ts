import { EntityId } from '@arcaai/domains';

/**
 * TASK-998 OD-4 — the OUTBOUND vendor-capacity limiter for cloud STT providers.
 *
 * > "platform admin will set minute volume by enabled provider globally OR
 * >  specific by tenant that has Pro plan and above"
 *
 * The numbers come from the entitlements plane
 * (`PlanEntitlement.sttProviderQuotas` = platform default,
 * `TenantEntitlement.sttProviderQuotas` = per-tenant allocation, merged per
 * dimension by `resolveProviderQuotas`); this service owns only the COUNTING
 * and the verdict.
 *
 * It is NOT the inbound `TieredThrottlerGuard` — see the table on
 * `provider-capacity.constants.ts` for why both exist.
 *
 * ## Fail posture, declared here and not decided at the call site
 *
 * | Situation                                    | Behaviour                    |
 * |----------------------------------------------|------------------------------|
 * | Redis unreachable / Lua failed / no Redis wired | **FAIL OPEN** — allow, log at WARN, count on `provider_capacity_check_skipped_total` |
 * | Enforcement kill-switch OFF                   | allow, no Redis touched      |
 * | Tenant ungated, or no limit resolved           | allow, no Redis touched      |
 * | An explicit OVER-LIMIT verdict                 | **FAIL CLOSED** — `QuotaExceededException` → 429 |
 *
 * That split is deliberate and is a clinical-safety judgement, not a
 * convenience: this sits on the path that starts a consultation recording.
 * Refusing to start one because a counter is unavailable is worse than briefly
 * over-running a vendor's quota (which the vendor itself will then rate-limit,
 * visibly, with a retryable error). An actual over-limit verdict is different —
 * we KNOW the call would be refused upstream, so refusing it here is strictly
 * better than paying for a round trip to find out.
 */
export interface IProviderCapacityService {
  /**
   * The sync-REST per-minute dimension. Call BEFORE submitting work that will
   * reach the vendor over REST — today, a batch transcription job.
   *
   * A no-op when the entitlements kill-switch is off, when `provider` is null
   * (a self-hosted engine has no vendor account to protect) or when neither
   * tier bounded this provider. Throws `QuotaExceededException`
   * (`capability: 'sttProviderRequestsPerMinute'` → 429) on an explicit
   * over-limit verdict.
   */
  assertRequestRate(tenantId: EntityId, provider: string | null | undefined): Promise<void>;

  /**
   * The concurrent-socket dimension. Call at session OPEN — the one moment
   * where refusing costs nothing.
   *
   * Idempotent per `sessionId`: re-acquiring a slot the session already holds
   * refreshes it and never re-checks the cap, so a resume is not refused by the
   * limit its own session is occupying.
   *
   * Throws `QuotaExceededException`
   * (`capability: 'sttProviderMaxConcurrentStreams'` → 429) on an explicit
   * over-limit verdict.
   */
  acquireStreamSlot(input: { tenantId: EntityId; provider: string | null | undefined; sessionId: string }): Promise<void>;

  /**
   * Re-stamp a held slot as live. Best-effort and never throws.
   *
   * Intended steady-state caller: the WS gateway's existing ~20 s heartbeat.
   * Without one, a slot is reclaimed `PROVIDER_STREAM_SLOT_TTL_SECONDS` after
   * the last acquire/refresh — see that constant for the crash story.
   */
  heartbeatStreamSlot(sessionId: string): Promise<void>;

  /**
   * Give a slot back at teardown. Best-effort and never throws — a release that
   * does not happen is covered by the TTL, so it must never be able to fail a
   * teardown that is already finalising a consultation.
   *
   * Takes only the `sessionId`: the provider and tenant are read from the
   * reverse index this service wrote at acquire, because most teardown paths
   * never saw the resolved ASR spec.
   */
  releaseStreamSlot(sessionId: string): Promise<void>;
}

export const IProviderCapacityService = Symbol('IProviderCapacityService');
