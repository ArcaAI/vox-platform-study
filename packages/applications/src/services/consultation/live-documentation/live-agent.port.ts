/**
 * The NARROW port through which the live loop learns
 * which agent governs a session.
 *
 * WHY A PORT AND NOT `PromptAssemblyService`. The live prompt is not the
 * template-assembly pipeline: it is a bespoke, prefix-cache-ordered
 * concatenation (`buildTextUserPrompt`) with no `{variable}` substitution, no
 * EXTERNAL_DATA spotlighting, and no DNA / few-shot / NER blocks. Injecting the
 * assembler would drag its DB reads (template row, DNA decrypt, exemplar
 * retrieval) toward the flush path and couple the live loop to finalize-only
 * concerns. This port carries exactly what the loop needs and nothing else.
 *
 * RESOLVE ONCE, FREEZE FOR THE SESSION (RF-6). The implementation is called at
 * `start()`, and the resulting {@link FrozenLiveAgentSnapshot} is what every
 * flush of that session serves — so a mid-session template edit/approval can
 * never mutate a running consultation, and a flush adds ZERO blocking I/O.
 *
 * NEVER THROWS. `resolveForSession` is contractually total: any failure yields
 * the code-default snapshot (the in-code constants). A live consultation must
 * never be failed by a prompt-resolution error — the documented fail-open
 * exception of, safe only because the code-default bytes are proven
 * byte-identical to the seeded SYSTEM default (paired sha256 guards).
 */

import type { LiveToolKey } from '../../departmentAgent/constants';

/** DI token for {@link ILiveAgentResolver}. */
export const ILiveAgentResolver = Symbol('ILiveAgentResolver');

/** Which tier of the live chain produced the frozen snapshot. */
export type LiveAgentTier = 'agent' | 'default' | 'code-default';

/** A single tool's frozen decision. `null` ⇒ follow the platform/env default. */
export interface ResolvedToolSetting {
  enabled: boolean | null;
}

/**
 * The normalized live tool plan. Always fully populated on the snapshot, so the
 * flush path never has to reason about absent config.
 *
 * NOTE FOR C4: the executor REGISTRY (and its richer `resolveToolPlan`) is C4's
 * territory; C3 only normalizes the agent's `toolConfig` JSONB into this shape
 * so the seam exists and the frozen snapshot can carry it. C4 may widen this
 * type additively (it must keep `version` as the schema-evolution anchor).
 */
export interface ResolvedToolPlan {
  version: 1;
  tools: Record<LiveToolKey, ResolvedToolSetting>;
}

/** Today's behavior expressed as config: NER + vitals on, groundedness per env. */
export const DEFAULT_LIVE_TOOL_PLAN: ResolvedToolPlan = Object.freeze({
  version: 1,
  tools: Object.freeze({
    ner: Object.freeze({ enabled: true }),
    vitals: Object.freeze({ enabled: true }),
    groundedness: Object.freeze({ enabled: null }),
  }),
}) as ResolvedToolPlan;

/**
 * Normalize an agent's `toolConfig` JSONB into a {@link ResolvedToolPlan}.
 *
 * Null / absent / malformed ⇒ {@link DEFAULT_LIVE_TOOL_PLAN} — i.e. exactly
 * today's behavior. Unknown tool keys are IGNORED here (they are already
 * rejected with a 400 at write time by `toolConfigProblems`); read-side
 * tolerance is the defense-in-depth half of that pair.
 *
 * Named `normalizeToolPlan` rather than `resolveToolPlan` so C4's registry can
 * introduce the latter without a name collision during the parallel lanes.
 */
export function normalizeToolPlan(toolConfig: unknown): ResolvedToolPlan {
  if (!toolConfig || typeof toolConfig !== 'object' || Array.isArray(toolConfig)) return DEFAULT_LIVE_TOOL_PLAN;
  const tools = (toolConfig as { tools?: unknown }).tools;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return DEFAULT_LIVE_TOOL_PLAN;

  const source = tools as Record<string, unknown>;
  const read = (key: LiveToolKey, fallback: boolean | null): ResolvedToolSetting => {
    const entry = source[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { enabled: fallback };
    const enabled = (entry as { enabled?: unknown }).enabled;
    if (enabled === null) return { enabled: null };
    if (typeof enabled === 'boolean') return { enabled };
    return { enabled: fallback };
  };

  return {
    version: 1,
    tools: {
      ner: read('ner', true),
      vitals: read('vitals', true),
      groundedness: read('groundedness', null),
    },
  };
}

/**
 * The immutable identity a live session serves for its WHOLE lifetime.
 *
 * `promptTemplateId` + `promptVersionNumber` pin an IMMUTABLE `PromptVersion`,
 * never "latest" — which is what makes cross-instance adoption and crash
 * recovery reconstruct a byte-identical agent (three-tier recovery).
 */
export interface FrozenLiveAgentSnapshot {
  resolvedFrom: LiveAgentTier;
  /** null on the `default` / `code-default` tiers. */
  agentId: string | null;
  agentName: string | null;
  /** null only on `code-default`. */
  promptTemplateId: string | null;
  promptVersionNumber: number | null;
  /** The prompt bytes served on every flush (replaces LIVE_SOAP_STABLE_SYSTEM_PREFIX). */
  stableUserPrefix: string;
  /** The TEXT `system_prompt` served on every flush. */
  systemPrompt: string;
  toolPlan: ResolvedToolPlan;
  /** Frozen per-task LLM override; null ⇒ per-flush `resolveTextSelection(tenantId,'live')` as today. */
  liveLlm: { provider: string; model: string } | null;
  frozenAt: string;
}

/**
 * The durable/Redis lineage block. A strict subset of the snapshot: everything
 * needed to RE-PIN the identical `PromptVersion`, without duplicating prompt
 * bytes into `ContextItem.metaData`.
 */
export interface PersistedLiveAgentLineage {
  agentId: string | null;
  agentName: string | null;
  promptTemplateId: string | null;
  promptVersionNumber: number | null;
  resolvedFrom: LiveAgentTier;
  liveLlm?: { provider: string; model: string } | null;
  frozenAt: string;
}

export interface ILiveAgentResolver {
  /** Resolve-and-freeze for a session. NEVER throws (fail-open to code-default). */
  resolveForSession(input: { consultationId: string; tenantId: string }): Promise<FrozenLiveAgentSnapshot>;

  /**
   * Re-pin a snapshot from a durable lineage block (crash recovery tier 2):
   * fetch the pinned, IMMUTABLE `PromptVersion` and rebuild the identical
   * snapshot. Returns null when the pin can no longer be honored, so the caller
   * falls through to a fresh resolve. NEVER throws.
   */
  rehydrateFromLineage(input: { tenantId: string; lineage: PersistedLiveAgentLineage }): Promise<FrozenLiveAgentSnapshot | null>;
}
