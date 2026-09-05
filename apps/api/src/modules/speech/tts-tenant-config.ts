import { TtsAgentResolverService } from '@arcaai/applications';
import type { ProviderOverrides, ResolvedTtsSpec } from '@arcaai/applications';

/**
 * The tenant's resolved SPEECH configuration for one request: which agent speaks, on which model,
 * in which voice, through which engine chain, with which credentials.
 *
 * TASK-879 replaced what this used to resolve. It was `TenantTtsConfig.getEffective` — routing
 * chains, an allowed-provider whitelist, voice bindings and format/speed/sample-rate defaults —
 * folded into every request as `routing_en` / `routing_ml` / `allowed_providers` /
 * `voice_bindings`. A capability is an AGENT now: the tenant → department → SYSTEM
 * `AgentAssignment` cascade selects a published `TEXT_TO_SPEECH` agent, and the resolved spec
 * carries the model (with its mirror, artifacts and voices), the connection row that serves each
 * engine, the parameters, and the ordered fallback chain.
 *
 * Extracted so the harness's internal synthesis route resolves through the SAME cascade the
 * user-facing proxy and the WS-duplex gateway do. Two spellings of "which engine speaks for this
 * tenant, on whose key" is exactly how the three drift apart, and the drift would be invisible:
 * all three would still synthesize, just not necessarily in the same voice or on the same
 * credential — which decides BYOK vs CLOUD funding.
 *
 * The RESOLVE is shared; the MAPPING onto each caller's own request shape is not, because the
 * three requests differ (the proxy honours a caller-supplied format/speed, the harness route
 * takes the workflow node's config, the socket enriches an init frame).
 *
 * Deliberately does NOT catch. Unlike the `TenantTtsConfig` fold it replaces, a resolution
 * failure here is FATAL rather than degrading: there is no service-side default left to fall back
 * to — `apps/tts` reads no selection of its own and refuses a request with no spec — so
 * swallowing the error would turn an attributable 404/409 into an opaque 503 from a downstream
 * service. Each caller surfaces it in its own shape.
 */
export interface ResolvedTtsRequestConfig {
  /** The gateway-resolved TEXT_TO_SPEECH agent, verbatim. Travels in the request body. */
  spec: ResolvedTtsSpec;
  /**
   * Decrypted BYO credentials keyed by ENGINE, each carrying its own `funding`. The map spans two
   * tiers — the tenant's own connection rows over the SYSTEM-tenant platform default — and
   * `classifyTtsProvider` reads `funding` back when the usage row is stamped.
   *
   * They ride BESIDE the spec, never on it: a credential must not travel on a document anything
   * downstream might persist or log.
   */
  overrides: ProviderOverrides;
}

export async function resolveTtsRequestConfig(
  tenantId: string,
  deps: { ttsAgentResolver: TtsAgentResolverService; agentSlug?: string | null; departmentId?: string | null },
): Promise<ResolvedTtsRequestConfig> {
  const { spec, providerOverrides } = await deps.ttsAgentResolver.resolve({
    tenantId,
    agentSlug: deps.agentSlug ?? null,
    departmentId: deps.departmentId ?? null,
  });
  return { spec, overrides: providerOverrides ?? {} };
}
