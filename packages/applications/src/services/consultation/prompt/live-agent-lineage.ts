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
 * anything that is not an object carrying a non-empty `agentId` is treated as
 * "no lineage" — degrading to exactly the pre-C5 behaviour rather than
 * fabricating provenance or crashing a finalize.
 */

import type { PersistedLiveAgentLineage } from '../live-documentation/live-agent.port';

export function readLiveAgentLineage(entity: { metaData?: unknown } | null | undefined): PersistedLiveAgentLineage | null {
  const agent = (entity?.metaData as { agent?: unknown } | undefined)?.agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  const lineage = agent as PersistedLiveAgentLineage;
  return typeof lineage.agentId === 'string' && lineage.agentId.length > 0 ? lineage : null;
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
