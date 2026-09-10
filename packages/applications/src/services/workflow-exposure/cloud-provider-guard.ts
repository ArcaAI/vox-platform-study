import { isCloudByoProvider } from '../ai-provider-connection/constants';

/**
 * Decision #6 (R-8, :
 * a PUBLICLY-invoked workflow may NOT route to a cloud LLM provider unless
 * the tenant has explicitly opted in — public exposure inherits the
 * strictest egress posture (fail-closed by default), and cloud selection is
 * an explicit opt-in, never a default.
 *
 * `compiledConfig.stages[].nodes[].config` is a free-form
 * `Record<string, unknown>` (`CompiledNode.config` in
 * `@arcaai/workflow-contract`'s `compiler.ts`) — this scans it for the
 * ESTABLISHED `provider` field-naming convention already used across the
 * codebase (`TextGenerateRequest.provider`, `AiRoutingPolicy.provider`,
 * `AiProviderConnection.provider`) rather than inventing a new signal.
 * `CLOUD_BYO_PROVIDERS`/`isCloudByoProvider` (`ai-provider-connection/constants.ts`)
 * is the SAME authoritative cloud-vs-local classification the BYO-credential
 * plane already uses — not a second, drifting list.
 *
 * Today this is a documented, wired, but CURRENTLY-INERT gate: the code-owned
 * node registry (`@arcaai/workflow-contract`'s `WORKFLOW_NODE_REGISTRY`) ships
 * only `noop`/`passthrough`, and neither ever sets `config.provider` — no
 * compiled graph can trip this check until a palette node that selects an LLM
 * provider exists (/731). It activates automatically the moment one
 * does, with no further wiring.
 *
 * Returns the first disallowed provider name found, or `null` when the
 * config is clean (never throws — the caller decides how to fail).
 */
export function findDisallowedCloudProvider(compiledConfig: unknown, allowCloudProviders: boolean): string | null {
  if (allowCloudProviders) return null;
  if (typeof compiledConfig !== 'object' || compiledConfig === null) return null;

  const stages = (compiledConfig as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return null;

  for (const stage of stages) {
    const nodes = (stage as { nodes?: unknown })?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const provider = (node as { config?: { provider?: unknown } })?.config?.provider;
      if (typeof provider === 'string' && isCloudByoProvider('llm', provider)) {
        return provider;
      }
    }
  }
  return null;
}
