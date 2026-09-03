/**
 * Credential-gated provider reconcilers.
 *
 * This replaces the hardcoded "always unavailable" stubs from.
 * Availability is now DERIVED from two independent gates, so the day a
 * credential lands in Vault nothing here needs editing:
 *
 *   1. **Is a client implemented?** — the spec carries `fetchControlTotal`.
 *      Absent = we have not written the vendor's HTTP call yet.
 *   2. **Is a read-only credential present?** — resolved through the platform
 *      secrets provider (Vault kv-v2), never from an env var or a tenant row.
 *
 * BOTH gates matter, and collapsing them would be a bug: a credential landing
 * before a client exists would flip availability to true, the job would call an
 * unimplemented fetch, and every run would log a transport failure that is
 * really just missing code. The two reasons read differently in the run log for
 * exactly that reason.
 *
 * ============================================================================
 * WHAT A RECONCILER IS ALLOWED TO ASK FOR (rules 1-2)
 * ============================================================================
 * - A **platform-wide, org-level** control total. No cloud vendor exposes
 *   per-tenant cost, so a reconciler answers "what did this provider bill the
 *   platform for this window", which is joined against the ledger's own
 *   platform-wide CLOUD-only sum.
 * - **READ-ONLY** scope. These credentials read a usage/cost report; none of
 *   them needs to create, modify or spend anything.
 * - Never a per-tenant key. BYOK usage runs on the TENANT's account and is out
 *   of scope by construction — the ledger side filters to `deployment: CLOUD`.
 */

import type { IProviderReconciler, ProviderControlTotal, ProviderReconcilerAvailability } from './provider-reconciler';
import type { ReconciliationWindow } from './provider-reconciliation-window';

/** Resolves a platform secret, or `undefined` when it is not provisioned. */
export type SecretLookup = (key: string) => Promise<string | undefined>;

/** The vendor call itself — the ONLY piece still outstanding per provider. */
export type FetchControlTotal = (credential: string, window: ReconciliationWindow) => Promise<ProviderControlTotal | null>;

export interface ProviderReconcilerSpec {
  provider: string;
  /** Vault kv-v2 key holding the READ-ONLY usage/cost credential. */
  secretKey: string;
  /** The endpoint a live client calls — carried so the run log can say what is missing. */
  endpointHint: string;
  /** Vendor-specific caveats worth surfacing before anyone trusts a number from it. */
  caveat?: string;
  /** Absent = client not implemented yet. Supplying this is what "wires up" a provider. */
  fetchControlTotal?: FetchControlTotal;
}

/**
 * The providers the platform can be billed by. Sourced from
 * research-findings.md; every entry names the exact
 * credential an operator has to provision.
 *
 * Deliberately NOT here: self-hosted engines (`whisper_cpp`, `kokoro`,
 * `lm-studio`, …). They have no vendor bill to reconcile against — their cost
 * is infrastructure, which the COST plane models directly.
 */
export const PROVIDER_RECONCILER_SPECS: readonly ProviderReconcilerSpec[] = [
  {
    provider: 'openai',
    secretKey: 'OPENAI_ADMIN_API_KEY',
    endpointHint: 'GET /v1/organization/usage/* (+ /v1/organization/costs, 1-day granularity)',
    caveat: 'Freshness is undocumented — measure it empirically before this feeds an alert threshold.',
  },
  {
    provider: 'anthropic',
    secretKey: 'ANTHROPIC_ADMIN_API_KEY',
    endpointHint: 'GET /v1/organizations/usage_report/messages (+ /cost_report; note plural "organizations")',
    caveat: 'Data is fresh ~5 min, but priority-tier costs are absent from the cost endpoint and Claude-on-Bedrock is not covered at all.',
  },
  {
    provider: 'azure',
    secretKey: 'AZURE_COST_MANAGEMENT_CREDENTIAL',
    endpointHint: 'ARM Cost Management (daily, ~4h refresh — dollars) or Monitor metrics (PT1M — tokens)',
    caveat: 'Cost Management gives dollars without tokens; Monitor gives tokens without dollars. Neither carries a tenant dimension.',
  },
  {
    provider: 'azure-speech',
    secretKey: 'AZURE_COST_MANAGEMENT_CREDENTIAL',
    endpointHint: 'ARM Cost Management, filtered to the Speech resource',
    caveat: 'Shares the ARM credential with `azure`; the split is by resource, not by key.',
  },
];

/**
 * One provider's reconciler. Never throws for "not configured" — reconciliation
 * is a diagnostic, and a missing credential must not fail the sweep closed
 * (rule 7).
 */
export class CredentialGatedReconciler implements IProviderReconciler {
  constructor(
    private readonly spec: ProviderReconcilerSpec,
    private readonly lookupSecret: SecretLookup,
  ) {}

  get provider(): string {
    return this.spec.provider;
  }

  get secretKey(): string {
    return this.spec.secretKey;
  }

  async checkAvailability(): Promise<ProviderReconcilerAvailability> {
    if (!this.spec.fetchControlTotal) {
      return { available: false, reason: `client not implemented — would call ${this.spec.endpointHint}` };
    }
    let credential: string | undefined;
    try {
      credential = await this.lookupSecret(this.spec.secretKey);
    } catch (error) {
      // A secrets-backend outage is NOT "unconfigured" — say so, so nobody
      // reads it as "the credential was never provisioned" and re-provisions it.
      return { available: false, reason: `secrets lookup failed for ${this.spec.secretKey}: ${(error as Error).message}` };
    }
    if (!credential) return { available: false, reason: `no credential at ${this.spec.secretKey} (read-only scope; ${this.spec.endpointHint})` };
    return { available: true };
  }

  async fetchControlTotal(windowStart: Date, windowEnd: Date): Promise<ProviderControlTotal | null> {
    if (!this.spec.fetchControlTotal) {
      // Loud on purpose: reaching here means a caller skipped checkAvailability.
      // Returning null instead would ship a fake zero into a drift comparison.
      throw new Error(`${this.spec.provider} reconciler has no client — call checkAvailability() before fetchControlTotal()`);
    }
    const credential = await this.lookupSecret(this.spec.secretKey);
    if (!credential)
      throw new Error(`${this.spec.provider} reconciler lost its credential (${this.spec.secretKey}) between availability check and fetch`);
    return this.spec.fetchControlTotal(credential, { start: windowStart, end: windowEnd });
  }
}

/** Build the registry against a secrets lookup. Shape is unchanged from the stub registry. */
export function buildProviderReconcilerRegistry(
  lookupSecret: SecretLookup,
  specs: readonly ProviderReconcilerSpec[] = PROVIDER_RECONCILER_SPECS,
): Map<string, IProviderReconciler> {
  return new Map(specs.map((spec) => [spec.provider, new CredentialGatedReconciler(spec, lookupSecret) as IProviderReconciler]));
}

/** Availability snapshot over the whole registry — what each run logs. */
export async function summarizeAvailability(
  registry: Map<string, IProviderReconciler>,
): Promise<Array<{ provider: string } & ProviderReconcilerAvailability>> {
  return Promise.all(
    Array.from(registry.values()).map(async (reconciler) => ({ provider: reconciler.provider, ...(await reconciler.checkAvailability()) })),
  );
}
