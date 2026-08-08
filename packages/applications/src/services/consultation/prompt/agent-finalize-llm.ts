/**
 * TASK-635 C5 / RF-4 — the FINALIZE half of the per-task agent LLM override.
 *
 * Precedence (RF-4, binding): agent `llmOverrides.finalize` → the tenant's
 * `smr.finalize` AiTaskDefault → fail-closed. This helper owns only the first
 * step; the tenant tier and the Wave-1 A4 single fallback retry stay exactly
 * where they are (`HarnessPolicyService.resolveSmrSelection` /
 * `resolveSmrFallbackSelection`), untouched.
 *
 * WHY A FREE FUNCTION AND NOT A METHOD ON THE LIVE RESOLVER. The live resolver
 * (`LiveAgentResolutionService.resolveLiveLlm`) is the `live` half and is
 * deliberately FAIL-OPEN — a running consultation must never be failed by a
 * model-selection problem, and degrading to the tenant `smr.live` default is
 * today's behaviour. Finalize is the opposite posture: model SELECTION is
 * FAIL-CLOSED (rule 09 §Configuration Tiers — an unresolved selection raises,
 * nothing is substituted), because silently finalizing a clinical note on a
 * different model than the tenant configured is a governance failure, not a
 * degradation. Two postures ⇒ two implementations, each stated at its call site.
 *
 * NEVER ONE GLOBAL OVERRIDE FIELD: `llmOverrides` is keyed by task precisely so
 * a low-latency live model cannot silently drive finalize (C1 §3.1).
 */

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModelTaskType, ResourceStatusType } from '@arcaai/domains';

export interface AgentFinalizeLlmDeps {
  /** Optional so existing positional test fixtures (which wire neither) keep compiling. */
  departmentAgentRepository?: { findById(id: string): Promise<{ llmOverrides?: unknown } | null> };
  aiModelRepository?: {
    findAll(props: {
      filters: Record<string, unknown>;
    }): Promise<Array<{ provider?: string | null; sourceUri?: string | null; taskType?: string | null }>>;
  };
  logger?: Logger;
}

/**
 * Resolve the session agent's finalize model, or null when there is no override
 * to apply (no lineage, repositories unwired, agent row gone, or no
 * `llmOverrides.finalize`) — in which case the caller keeps the tenant tier.
 *
 * @throws ServiceUnavailableException when the agent NAMES a finalize model that
 *   cannot be served (unknown / disabled / not TEXT_GENERATION / no sourceUri).
 *   Fail-closed: an explicitly configured selection that cannot be honoured must
 *   surface, never be silently replaced by the tenant default.
 */
export async function resolveAgentFinalizeSelection(
  deps: AgentFinalizeLlmDeps,
  agentId: string | null | undefined,
): Promise<{ provider: string; model: string } | null> {
  if (!agentId || !deps.departmentAgentRepository || !deps.aiModelRepository) return null;

  let llmOverrides: unknown;
  try {
    // A deleted / tidied-up agent is NOT a finalize failure — the same
    // fall-through posture as `pinnedAgentId` in the resolver (C1 §7.4).
    const agent = await deps.departmentAgentRepository.findById(agentId);
    llmOverrides = agent?.llmOverrides ?? null;
  } catch (error) {
    deps.logger?.warn({
      message: 'Session agent could not be loaded for the finalize LLM override — using the tenant smr.finalize default',
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const slug = (llmOverrides as { finalize?: { aiModelSlug?: unknown } } | null | undefined)?.finalize?.aiModelSlug;
  if (typeof slug !== 'string' || slug.trim().length === 0) return null;

  const models = await deps.aiModelRepository.findAll({ filters: { slug, resourceStatus: ResourceStatusType.ENABLED } });
  const model = models[0];
  if (!model || model.taskType !== ModelTaskType.TEXT_GENERATION || !model.sourceUri) {
    throw new ServiceUnavailableException(`The session agent's configured finalize model '${slug}' is not available`);
  }
  // The catalog seeds `azure`; SMR registers it as `azure-openai`
  // (mirrors HarnessPolicyService.resolveSmrSelection and resolveLiveLlm).
  const provider = model.provider === 'azure' ? 'azure-openai' : (model.provider ?? '');
  if (!provider) {
    throw new ServiceUnavailableException(`The session agent's configured finalize model '${slug}' has no provider`);
  }
  return { provider, model: model.sourceUri };
}
