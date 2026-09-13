import { AiCostBasis, AiDeploymentKind } from '@arcaai/domains';

/**
 * The ONE TTS billing classifier (OD-4).
 *
 * `SpeechProxyController` (HTTP) and `TtsWsGateway` (WS duplex) both turn a
 * served provider into a `(deployment, costBasis)` pair, and until this module
 * existed they did it with two verbatim copies of the same function and the
 * same allow-list. Two hand-synced copies of a *billing* classifier is how the
 * next mis-rating ships, so R3 — which has to change both anyway — collapses
 * them here.
 *
 * (The LLM/harness pair, `text-usage.ts` and `harness-usage.mapper.ts`, keep
 * their own copies: they classify a different capability from a different
 * input and belong to their own ticket. OD-4 scopes this dedup to TTS.)
 */

/**
 * WHO PAID for a provider call.
 *
 * The gateway may inject a `provider_overrides` entry from two different tiers:
 * the caller tenant's own connection row, or the SYSTEM-tenant platform
 * default. Those are the same bytes on the wire and opposite economics —
 * tenant-funded spend is metered notionally and never invoiced, platform-funded
 * spend is real COGS the platform must recover — so the origin travels
 * EXPLICITLY rather than being inferred from the presence of a credential.
 */
export type ProviderFunding = 'tenant' | 'platform';

/**
 * Self-hosted TTS engine ids (`KNOWN_PROVIDERS`,
 * `packages/applications/.../vocabulary.ts`). Anything else is a vendor the
 * platform pays per call.
 */
export const SELF_HOSTED_TTS_PROVIDERS: ReadonlySet<string> = new Set(['kokoro', 'indic_parler']);

/**
 * `provider → entry`, with the entry left as `unknown`.
 *
 * Deliberately NOT `ProviderOverrides` from `@arcaai/applications`: this module
 * reads exactly one non-secret label off the entry and nothing else, so keeping
 * the value opaque means it accepts both call sites' local wire types AND the
 * shared one — and keeps compiling whether or not `ProviderOverrideEntry` has
 * declared `funding` yet. Opaque also means this module structurally cannot
 * touch `api_key`.
 */
export type ProviderOverrideMapLike = Readonly<Record<string, unknown>> | null | undefined;

/**
 * Read the funding origin off one override entry.
 *
 * An ABSENT (or unrecognized) value means `'tenant'`. That is not a hedge: a
 * sender that does not stamp funding is a gateway with no platform-default
 * tier to draw from, so every credential it is capable of injecting is the
 * calling tenant's own. The default is therefore exactly correct for every
 * pre-R3 caller, and the degradation direction for a malformed value is the
 * conservative one (it can never silently convert tenant-funded spend into a
 * platform COGS charge).
 */
export function readOverrideFunding(entry: unknown): ProviderFunding {
  return (entry as { funding?: unknown } | null | undefined)?.funding === 'platform' ? 'platform' : 'tenant';
}

/**
 * The override entry that actually SERVED, out of a map that may hold several
 * for one provider (TASK-958).
 *
 * `provider_overrides` is keyed by CONNECTION KEY: the provider id for the
 * tenant's default connection and for the platform's, `provider:slug` for a
 * named sibling. Reading `map[provider]` therefore MISSED a tenant that had
 * bound its agent to a second account of the same vendor — its own BYOK spend
 * was then classified as platform `CLOUD` and landed in platform COGS.
 *
 * Lookup order, most specific first:
 *   1. the entry whose `connection_id` is the one the service reported serving;
 *   2. the exact `provider` key (every pre-958 payload, and every default row);
 *   3. EXACTLY ONE `provider:`-prefixed entry — unambiguous, so the tenant that
 *      brought one named account is still credited when the service predates
 *      the header;
 *   4. nothing. Two siblings and no id is genuinely ambiguous, and a guessed
 *      funding label mis-bills silently in whichever direction it guessed.
 */
function servingEntry(provider: string, providerOverrides: ProviderOverrideMapLike, connectionId?: string | null): unknown {
  if (!providerOverrides) return undefined;
  if (connectionId) {
    const matched = Object.values(providerOverrides).find((entry) => (entry as { connection_id?: unknown } | null)?.connection_id === connectionId);
    if (matched) return matched;
  }
  const exact = providerOverrides[provider];
  if (exact) return exact;
  const prefixed = Object.keys(providerOverrides).filter((key) => key.startsWith(`${provider}:`));
  return prefixed.length === 1 ? providerOverrides[prefixed[0]] : undefined;
}

/**
 * The sentinel `apps/tts` sends when it cannot name the engine that served
 * (`tts/core/usage.py:23`, stamped on the response at
 * `tts/api/endpoints/speech.py:184`).
 *
 * Copied, not invented — and the reason it is a CONSTANT here is that all four
 * gateway readers must recognise the same spelling. A reader that missed it
 * would write the row the other three skip.
 */
export const TTS_UNKNOWN_PROVIDER = 'none';

/**
 * Can this synthesis be attributed to a provider at all? (TASK-957 F-10)
 *
 * `false` for an absent/empty header AND for {@link TTS_UNKNOWN_PROVIDER} —
 * the service declining to name an engine is the same fact as a header that
 * never arrived, and the gateway has no third source to consult.
 *
 * A caller that writes a row anyway asserts two things the evidence does not
 * support: `provider: 'none'` (a provider id in no price book, so the row rates
 * at zero COGS while still draining the tenant's CHARACTER allowance first) and
 * `deployment: SELF_HOSTED` (the platform's own hardware ran it — the one claim
 * the missing header directly contradicts). Skipping is the correctable
 * direction: the synthesis is reconstructible from the service's own logs, a
 * wrong deployment on an invoice is not.
 */
export function isAttributableTtsProvider(provider: string | null | undefined): provider is string {
  return typeof provider === 'string' && provider.length > 0 && provider !== TTS_UNKNOWN_PROVIDER;
}

/**
 * `(provider, injected overrides, served connection) → (deployment, costBasis)`.
 *
 * Precedence, unchanged from the two copies this replaces: a tenant credential
 * for THIS provider outranks the self-hosted set, which outranks platform-funded
 * cloud. What R3 changed is only the first test — from "is there an entry" to
 * "is there an entry the TENANT is paying for"; TASK-958 changes only HOW that
 * entry is found (see {@link servingEntry}).
 *
 * Key-specific throughout: an override for a different provider says nothing
 * about who paid for this one.
 */
export function classifyTtsProvider(
  provider: string,
  providerOverrides: ProviderOverrideMapLike,
  connectionId?: string | null,
): { deployment: AiDeploymentKind; costBasis?: AiCostBasis } {
  const entry = servingEntry(provider, providerOverrides, connectionId);
  if (entry && readOverrideFunding(entry) === 'tenant') {
    return { deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL };
  }
  if (SELF_HOSTED_TTS_PROVIDERS.has(provider)) {
    return { deployment: AiDeploymentKind.SELF_HOSTED };
  }
  // Platform-funded vendor call — including a platform-funded OVERRIDE, which
  // is economically identical to serving on the platform's env credential
  // (: `CLOUD`, no new `AiDeploymentKind` member). `costBasis` is
  // deliberately omitted so the ledger's INTERNAL default applies.
  return { deployment: AiDeploymentKind.CLOUD };
}
