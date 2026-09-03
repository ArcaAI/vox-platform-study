/**
 * Provider usage/cost-API reconciler INTERFACE (credential
 * gating added in). Implementations live in
 * `provider-reconciler-registry.ts`.
 *
 * Per research-findings.md, no cloud provider gives per-request,
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

  /**
   * Credential/config check — NO network call to the vendor, but async because
   * resolving a credential means asking Vault. Must never throw:
   * "unconfigured" is a normal answer, and reconciliation must not fail the
   * sweep closed (rule 7).
   */
  checkAvailability(): Promise<ProviderReconcilerAvailability>;

  /**
   * Fetches the platform-wide control total for `[windowStart, windowEnd)`.
   * Implementations MUST NOT throw for "not configured" — call
   * {@link checkAvailability} first and skip instead. A thrown error here is
   * reserved for a genuine transport/API failure once the client is wired.
   */
  fetchControlTotal(windowStart: Date, windowEnd: Date): Promise<ProviderControlTotal | null>;
}

/**
 * Implementations live in `provider-reconciler-registry.ts`
 * ({@link CredentialGatedReconciler}), which derives availability from a real
 * Vault lookup plus whether a vendor client exists. The hardcoded
 * always-unavailable stub registry that used to live here was removed in
 * It could not tell "no credential provisioned" from "no client
 * written", and those need different actions from an operator.
 */
