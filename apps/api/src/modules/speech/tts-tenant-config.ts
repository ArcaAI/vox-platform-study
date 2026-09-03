import { IProviderConnectionService, ITenantTtsConfigService } from '@arcaai/applications';
import type { ProviderOverrides } from '@arcaai/applications';

/**
 * The tenant's resolved TTS request configuration — routing chains, allowed providers, BYO
 * credentials, voice bindings and format/speed defaults.
 *
 * Extracted from `SpeechProxyController.applyTenantConfig` by lane B so the harness's
 * internal synthesis route resolves through the SAME cascade the user-facing proxy does. Two
 * spellings of "which provider serves this tenant's speech, on whose key" is exactly how the two
 * drift apart, and the drift would be invisible: both would still synthesize, just not
 * necessarily on the same provider or the same credential — which decides BYOK vs CLOUD funding.
 *
 * The RESOLVE is shared; the MAPPING onto each caller's own request shape is not, because the two
 * requests differ (the proxy honours a caller-supplied format/speed, the harness route takes the
 * node's config). Sharing the mapping too would mean inventing a union request type that neither
 * caller actually has.
 *
 * Deliberately does NOT catch: both callers fail OPEN on a resolution error (tts falls back to its
 * own settings) but each wants its own log line and its own fallback, and swallowing the error
 * here would hide which of them degraded.
 */
export interface ResolvedTtsTenantConfig {
  /** The effective per-tenant TTS spec (tenant → SYSTEM), verbatim. */
  eff: Awaited<ReturnType<ITenantTtsConfigService['getEffective']>>;
  /**
   * Decrypted BYO credentials keyed by provider, each carrying its own `funding`. The map spans
   * two tiers — the tenant's own connection rows over the SYSTEM-tenant platform default — and
   * `classifyTtsProvider` reads `funding` back when the usage row is stamped.
   */
  overrides: ProviderOverrides;
}

export async function resolveTtsTenantConfig(
  tenantId: string,
  deps: {
    tenantTtsConfig: ITenantTtsConfigService;
    providerConnectionService?: IProviderConnectionService;
  },
): Promise<ResolvedTtsTenantConfig> {
  const [eff, resolved] = await Promise.all([
    deps.tenantTtsConfig.getEffective(tenantId),
    deps.providerConnectionService
      ? deps.providerConnectionService.resolveTenantCloudOverrides('tts', tenantId)
      : Promise.resolve({ overrides: {} as ProviderOverrides }),
  ]);
  return { eff, overrides: resolved.overrides };
}
