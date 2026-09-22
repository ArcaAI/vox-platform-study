/**
 * TASK-1000 — the output-token budget for one live-summary generation.
 *
 * ## Why this is computed and not declared
 *
 * Every `arcaai-*-summary-*` agent shipped `parameters.generation.maxTokens = 2048`, one shared
 * seed constant across 22 agents whose note templates run from 5 to 23 sections. A turn document
 * for a 14-section template outgrew 2048 tokens partway through a real consultation; the engine
 * cut the JSON mid-string, and the degrade path wrote the fragment into the note's first section.
 *
 * A single number cannot be right for both a 5-section diet revisit and a 23-section surgical
 * oncology intake, so the budget is derived from the template the flush is actually filling:
 *
 *     budget = clamp(agent's declared value, floor(sections), ceiling)
 *
 * ## Why a FLOOR rather than trusting the agent
 *
 * `Agent.parameters` is immutable once published (a DB trigger enforces it) and the reference-set
 * resync is `missing-only`, so the 22 rows already carrying 2048 cannot be corrected by an UPDATE
 * and are not reachable by a re-seed. The floor is therefore the only mechanism that reaches a
 * tenant already running — and it is the right shape regardless: a budget below what the template
 * structurally requires is not a tenant preference, it is a note that cannot be finished.
 *
 * ## Why a CEILING, and why it is not the same number as before
 *
 * `consultation.realtime.textMaxTokens` documents itself as a "`max_tokens` ceiling on every
 * realtime TEXT generation" but was applied as `agent.maxTokens ?? ceiling` — a `??`, so any
 * agent value REPLACED it. That is how a content-tier 2048 silently defeated a platform budget of
 * 8192. It is now a real bound. Its default rises to 16384 so that it stays above the largest
 * floor this rule can produce (23 sections ⇒ 11,776); a ceiling below the floor would be a
 * contradiction the clamp could not honour.
 */

/** Per-section allowance. 23 sections ⇒ 11,776; anything ≤ 16 sections sits on the floor. */
export const OUTPUT_TOKENS_PER_SECTION = 512;

/**
 * The absolute floor, owner-directed (2026-09-22, "Min 8192").
 *
 * The measured failure was a 14-section template at 2048. 8192 is 4× that, which covers the
 * observed complete-turn sizes (1,725–2,019 predicted tokens early in a session) with room for
 * the growth that broke it.
 */
export const OUTPUT_TOKENS_ABSOLUTE_FLOOR = 8192;

/**
 * The smallest budget a template of `sectionCount` sections may generate under.
 *
 * A non-finite or non-positive count degrades to the absolute floor rather than to zero: an
 * unresolvable template is a reason to be generous, never a reason to truncate.
 */
export function outputBudgetFloor(sectionCount: number): number {
  if (!Number.isFinite(sectionCount) || sectionCount <= 0) return OUTPUT_TOKENS_ABSOLUTE_FLOOR;
  return Math.max(OUTPUT_TOKENS_ABSOLUTE_FLOOR, Math.ceil(sectionCount) * OUTPUT_TOKENS_PER_SECTION);
}

/**
 * Resolve the budget for one generation.
 *
 * `declared` is the agent's own `parameters.generation.maxTokens` — honoured whenever it sits
 * between the template's floor and the platform ceiling, raised to the floor when it is below it,
 * and capped at the ceiling when it is above. An absent declaration takes the floor.
 *
 * A ceiling BELOW the floor is a misconfiguration rather than an instruction to truncate, so the
 * floor wins; the caller logs it.
 */
export function resolveOutputBudget(declared: number | undefined, sectionCount: number, ceiling: number): number {
  const floor = outputBudgetFloor(sectionCount);
  const bounded = Number.isFinite(ceiling) && ceiling > 0 ? Math.max(floor, ceiling) : floor;
  if (declared === undefined || !Number.isFinite(declared) || declared <= 0) return floor;
  return Math.min(Math.max(declared, floor), bounded);
}

/**
 * The budget for the ONE corrective retry (OD-5: "retry with a larger budget").
 *
 * Double the attempt that failed, capped by the ceiling. Doubling rather than a fixed number
 * because the reason the first attempt ran out is that the document is larger than the budget
 * assumed — and the amount by which it overran is unknown, so the retry buys the widest margin
 * the ceiling allows rather than a guess at the shortfall.
 */
export function repairOutputBudget(base: number, ceiling: number): number {
  const bounded = Number.isFinite(ceiling) && ceiling > 0 ? Math.max(base, ceiling) : base;
  return Math.min(base * 2, bounded);
}
