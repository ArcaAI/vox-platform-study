/**
 * The ONE reader of the live session's agent lineage.
 *
 * C3 stamps a {@link PersistedLiveAgentLineage} block onto the durable
 * `LIVE_SOAP_SNAPSHOT` ContextItem's `metaData.agent`. Both finalize paths
 * (`SummaryService.generateSummary` and `HarnessInternalService`) read it
 * through this function so they can never disagree about whether a session had
 * an agent — which is the whole basis of the DR-4 gating decision.
 *
 * DEFENSIVE BY DESIGN. `metaData` is untyped JSONB written by another lane, so
 * anything that is not an object carrying a RECOGNIZED `resolvedFrom` tier is
 * treated as "no lineage" — degrading to exactly the pre-C5 behaviour rather
 * than fabricating provenance or crashing a finalize.
 *
 * THE TIER, NOT THE AGENT ID, IS WHAT MAKES A BLOCK REAL. `agentId` is null on
 * the `default` and `code-default` tiers by contract (see
 * {@link FrozenLiveAgentSnapshot}), and since TASK-815 it is the workflow NODE
 * id — so a session that ran on the governed SYSTEM live default legitimately
 * carries no id. Gating on `agentId` therefore DISCARDED genuine provenance for
 * those sessions: finalize wrote `sessionAgentPromptVersion: null` for a live
 * loop that had in fact served a pinned, immutable `PromptVersion`.
 */

import type { LiveAgentTier, PersistedLiveAgentLineage } from '../live-documentation/live-agent.port';

const LIVE_AGENT_TIERS: readonly LiveAgentTier[] = ['agent', 'default', 'code-default'];

export function readLiveAgentLineage(entity: { metaData?: unknown } | null | undefined): PersistedLiveAgentLineage | null {
  const agent = (entity?.metaData as { agent?: unknown } | undefined)?.agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  const lineage = agent as PersistedLiveAgentLineage;
  return LIVE_AGENT_TIERS.includes(lineage.resolvedFrom) ? lineage : null;
}

/**
 * The `SummaryMeta.sessionAgentPromptVersion` string: `"<templateId>@<n>"` —
 * the IMMUTABLE PromptVersion the LIVE loop served. `code-default@0` records a
 * session that ran on the in-code fail-open tier (tier 3), which is
 * genuine provenance, not a missing value.
 */
export function formatSessionAgentPromptVersion(lineage: PersistedLiveAgentLineage | null | undefined): string | null {
  if (!lineage) return null;
  return `${lineage.promptTemplateId ?? 'code-default'}@${lineage.promptVersionNumber ?? 0}`;
}
