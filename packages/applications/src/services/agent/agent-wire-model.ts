/**
 * TASK-890 F9 — the ROUTED model id an agent call puts on the wire.
 *
 * §3.1 re-pointed routing off the locator `sourceUri` onto `AiModel.wireModelId`, the
 * provider-native id the engine or vendor answers to (`lms-gemma-4-e2b-it-qat` is the HOPE
 * catalogue KEY; `gemma-4-e2b-it-qat` is what LM Studio knows). `toTextCandidate`
 * (`text-generation-spec.ts`) has sent that id on the realtime/harness lane ever since; the
 * standalone invocation lane and the draft bench had not been repointed, and sent the slug —
 * which LM Studio answered `Invalid model identifier` (`model_not_found`), surfacing as a 502.
 *
 * Two tiers, in this order, because they answer two different questions:
 *
 *  1. **the live catalogue row** the resolver already materialised (`ResolvedAgent.models`) —
 *     the same value `toTextCandidate` routes on, so both lanes send ONE id for one agent, and
 *     a corrected `wireModelId` reaches the wire without republishing every agent bound to it;
 *  2. **the frozen `compiledConfig.model.wireModelId`** publish stamps, which makes a published
 *     version self-contained (like `resolvedPrompt`) for any consumer holding the artifact
 *     without a resolve.
 *
 * A version published BEFORE the freeze carries nothing at (2) and there is no republish, so (1)
 * is what keeps every seeded platform agent invocable.
 */
import type { AgentCompiledConfig, ResolvedAgent } from '@arcaai/types';
import { primaryModelOf } from './text-generation-spec';

/**
 * `AgentCompiledConfig['model']` plus the wire id publish freezes onto it.
 *
 * ADDITIVE-OPTIONAL and declared here rather than in `@arcaai/types`: every artifact published
 * before this fix carries no such key, and absence must read as "resolve it live", never as
 * "unroutable".
 */
export type CompiledModelRef = AgentCompiledConfig['model'] & { wireModelId?: string | null };

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** The wire id FROZEN into a published artifact, or `null` when the version predates the freeze. */
export function frozenWireModelId(compiled: AgentCompiledConfig): string | null {
  return trimmed((compiled.model as CompiledModelRef).wireModelId);
}

/** The id this agent's PRIMARY model goes on the wire as, or `null` when no tier declares one. */
export function wireModelIdOf(resolved: ResolvedAgent): string | null {
  return trimmed(primaryModelOf(resolved)?.wireModelId) ?? frozenWireModelId(resolved.compiledConfig);
}
