import { AgentTask } from '@arcaai/domains';

/**
 * TASK-974 D-1 — the PLATFORM HIDDEN AGENTS: SYSTEM-tenant agents that serve a platform
 * CAPABILITY for every tenant and are never part of a tenant's own content.
 *
 * ─── Why an allow-list in code rather than a column ────────────────────────────────────────
 *
 * `Agent` carries no visibility column, and adding one would make "hidden" a per-row data edit
 * — which is exactly what this must not be. A hidden agent is read at runtime by an EXPLICIT,
 * unscoped, `tenantId = SYSTEM` read (`AgentRepository.findPlatformHiddenBySlug`), the second
 * declared family of two-tenant reads after the reference library. Widening that family is a
 * platform decision, so the list of slugs it may serve is compiled in, reviewed in one place,
 * and cannot be grown by writing a row.
 *
 * ─── What "hidden" MEANS (each half is enforced where it belongs) ──────────────────────────
 *
 *  1. NEVER CLONED. `TenantReferenceSetService.copyAgents` skips these slugs, so a tenant never
 *     owns a copy whose model it could change out from under the platform (D-1: this agent is
 *     CONFIGURATION, not the cloned CONTENT of TASK-890 OD-M).
 *  2. NEVER SERVED ON THE BUSINESS PLANE. `AgentService.listPublished` omits them and
 *     `getPublishedBySlug` / the invoke path answer 404 — in EVERY tenant, Global included.
 *     Admin surfaces still see the row, flagged `hidden: true`, so a console can label it.
 *  3. NEVER ASSIGNABLE. `AgentAssignmentService.upsert` refuses one as an `agentSlug` (409):
 *     an assignment is a tenant saying "this agent serves that task for me", and a platform
 *     service agent is reached by its own resolver, never by the cascade.
 *
 * Authoring is unchanged: the platform admin edits the Global playground row and promotes it
 * into SYSTEM (`POST admin/agents/promote-to-system`).
 */
export interface PlatformHiddenAgent {
  /** The task the SYSTEM row must carry; a row of another task is a misconfiguration, not a match. */
  task: AgentTask;
  /** Why this capability is platform-owned — the record a reviewer reads before adding a second entry. */
  purpose: string;
}

/** The ONE hidden lineage key today. Adding a second is a code change AND an owner decision, by design. */
export const PLATFORM_HIDDEN_AGENTS = {
  'dna-writing-style-analyst': {
    task: AgentTask.TEXT_GENERATION,
    purpose:
      "Extracts a clinician's DNA writing-style profile from their writing samples. The platform admin owns its " +
      'model, fallback chain and hyper-parameters; a tenant may override only the instruction, through its own ' +
      'DNA_ANALYSIS prompt template.',
  },
} as const satisfies Record<string, PlatformHiddenAgent>;

/** The lineage keys of {@link PLATFORM_HIDDEN_AGENTS}, as a type. */
export type PlatformHiddenAgentSlug = keyof typeof PLATFORM_HIDDEN_AGENTS;

/** The DNA writing-style analyst — named so the processor, the seed and the tests cannot spell it differently. */
export const DNA_WRITING_STYLE_ANALYST_SLUG = 'dna-writing-style-analyst' satisfies PlatformHiddenAgentSlug;

/**
 * Is `slug` a declared platform hidden agent? Compared by EQUALITY — never by prefix and never
 * case-insensitively, because a lineage key is an exact identifier and a loose match here would
 * hide a tenant's own agent (or expose the platform's).
 */
export function isPlatformHiddenAgentSlug(slug: string): slug is PlatformHiddenAgentSlug {
  return Object.prototype.hasOwnProperty.call(PLATFORM_HIDDEN_AGENTS, slug);
}
