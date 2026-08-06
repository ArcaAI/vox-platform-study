/**
 * Provider usage/cost-API reconciler INTERFACE + a stub registry (TASK-615
 * WS-K scope note): "implement the INTERFACE + a stub registry only — real
 * HTTP clients need credentials the platform may not have."
 *
 * Per research-findings.md §11.2, no cloud provider gives per-request,
 * per-tenant cost — every reconciler here answers a PLATFORM-WIDE control
 * total (usage-type × day), never a tenant slice, and is joined against the
 * ledger's own platform-wide sum for the same window. A reconciler that has
 * no credentials configured reports itself `unavailable` rather than
 * throwing — reconciliation is a diagnostic, and a missing credential must
 * never fail the shadow-metering job closed.
 */

export interface ProviderControlTotal {
  provider: string;
  /** UTC half-open window this control total covers. */
  windowStart: Date;
  windowEnd: Date;
  /** Provider-reported unit (their vocabulary, not ours — e.g. "tokens", "characters", "requests"). */
  unit: string;
  quantity: number;
}

export type ProviderReconcilerAvailability = { available: true } | { available: false; reason: string };

/**
 * One provider's usage/cost-API client. `fetchControlTotal` returns `null`
 * when the provider genuinely reports nothing for the window (an empty
 * bucket, not an error) — the caller treats `null` the same as "no rows",
 * never as a breach.
 */
export interface IProviderReconciler {
  readonly provider: string;

  /** Cheap, synchronous credential/config check — no network call. */
  checkAvailability(): ProviderReconcilerAvailability;

  /**
   * Fetches the platform-wide control total for `[windowStart, windowEnd)`.
   * Implementations MUST NOT throw for "not configured" — call
   * {@link checkAvailability} first and skip instead. A thrown error here is
   * reserved for a genuine transport/API failure once the client is wired.
   */
  fetchControlTotal(windowStart: Date, windowEnd: Date): Promise<ProviderControlTotal | null>;
}

/**
 * A reconciler that is always unavailable — the honest placeholder for a
 * provider whose real HTTP client is not yet built. Documents exactly what
 * each provider needs (research-findings.md §11.2) so wiring the real client
 * later is a credential + fetch implementation, not a design decision.
 */
class StubProviderReconciler implements IProviderReconciler {
  constructor(
    public readonly provider: string,
    private readonly missingCredentialHint: string,
  ) {}

  checkAvailability(): ProviderReconcilerAvailability {
    return { available: false, reason: `not implemented — needs ${this.missingCredentialHint}` };
  }

  async fetchControlTotal(): Promise<ProviderControlTotal | null> {
    // Never called in practice — the reconciliation job checks
    // `checkAvailability()` first and skips disabled reconcilers. Throwing
    // here (rather than silently returning null) makes a future caller that
    // skips the availability check fail loudly instead of shipping a fake 0.
    throw new Error(`${this.provider} reconciler is a stub (${this.missingCredentialHint}) — call checkAvailability() before fetchControlTotal()`);
  }
}

/**
 * The stub registry. Every entry documents the real credential/endpoint the
 * live client would need — see research-findings.md §11.2:
 *   - OpenAI:    an Admin API key (`OPENAI_ADMIN_API_KEY`) for
 *                `GET /v1/organization/usage/*` (+ `/v1/organization/costs`,
 *                1-day granularity only). Freshness is undocumented — must be
 *                measured empirically before it feeds an alert threshold.
 *   - Anthropic: an admin-scoped API key for
 *                `GET /v1/organizations/usage_report/messages` (+
 *                `/cost_report`, note plural "organizations"). Data is fresh
 *                ~5 minutes; priority-tier costs are absent from the cost
 *                endpoint; not available at all for Claude-on-Bedrock.
 *   - Azure:     an ARM-scoped credential for Cost Management (daily, 4-hour
 *                refresh — dollars, no tokens) OR Monitor metrics (PT1M —
 *                tokens, no dollars); no tenant dimension unless tenant ==
 *                deployment/resource-group/Foundry-project.
 *
 * None of the three has a credential provisioned in this platform today (per
 * the WS-K task brief — "the platform may not have them"), so every entry is
 * a {@link StubProviderReconciler}. Swapping one for a real client is a
 * drop-in replacement: the registry's shape and the reconciliation job's
 * consumption of it do not change.
 */
export function buildStubProviderReconcilerRegistry(): Map<string, IProviderReconciler> {
  return new Map<string, IProviderReconciler>([
    ['openai', new StubProviderReconciler('openai', 'OPENAI_ADMIN_API_KEY (GET /v1/organization/usage/*)')],
    ['anthropic', new StubProviderReconciler('anthropic', 'an admin-scoped API key (GET /v1/organizations/usage_report/messages)')],
    ['azure', new StubProviderReconciler('azure', 'an ARM credential for Cost Management or Monitor metrics')],
  ]);
}

/** Availability snapshot over the whole registry — what the shadow report logs per run. */
export function summarizeProviderReconcilerAvailability(
  registry: Map<string, IProviderReconciler>,
): Array<{ provider: string } & ProviderReconcilerAvailability> {
  return Array.from(registry.values()).map((reconciler) => ({
    provider: reconciler.provider,
    ...reconciler.checkAvailability(),
  }));
}
