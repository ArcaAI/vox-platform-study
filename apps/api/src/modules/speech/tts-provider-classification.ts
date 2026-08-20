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
 * `(provider, injected overrides) → (deployment, costBasis)`.
 *
 * Precedence, unchanged from the two copies this replaces: a tenant credential
 * for THIS provider outranks the self-hosted set, which outranks platform-funded
 * cloud. What R3 changes is only the first test — from "is there an entry" to
 * "is there an entry the TENANT is paying for".
 *
 * Key-specific throughout: an override for a different provider says nothing
 * about who paid for this one.
 */
export function classifyTtsProvider(
  provider: string,
  providerOverrides: ProviderOverrideMapLike,
): { deployment: AiDeploymentKind; costBasis?: AiCostBasis } {
  const entry = providerOverrides ? providerOverrides[provider] : undefined;
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
