import { USER_PERSONAL_SCOPE, type AvailablePrompt } from '../api/prompts';

export interface PartitionedPrompts {
  /** Templates the caller OWNS (scope === USER_PERSONAL) — editable + deletable. */
  personal: AvailablePrompt[];
  /** Tenant / department defaults — read-only, but selectable as preferred. */
  defaults: AvailablePrompt[];
}

/**
 * TASK-356 Phase 6 (S7) — split the caller's available templates into the ones
 * they OWN (personal) and the read-only defaults. `listAvailableForCaller`
 * already filters personals to the caller, so `scope === USER_PERSONAL` is a
 * sufficient ownership signal here.
 */
export function partitionAvailablePrompts(prompts: AvailablePrompt[] | undefined): PartitionedPrompts {
  const personal: AvailablePrompt[] = [];
  const defaults: AvailablePrompt[] = [];
  for (const p of prompts ?? []) {
    if (p.scope === USER_PERSONAL_SCOPE) personal.push(p);
    else defaults.push(p);
  }
  return { personal, defaults };
}

/**
 * TASK-356 Phase 6 (S7) — find a read-only default in the same category to diff a
 * personal prompt against (the "default → your version" comparison). Returns the
 * first non-personal template sharing the personal's category, or `undefined`.
 */
export function findCategoryDefault(personal: AvailablePrompt, prompts: AvailablePrompt[] | undefined): AvailablePrompt | undefined {
  return (prompts ?? []).find((p) => p.scope !== USER_PERSONAL_SCOPE && p.category === personal.category);
}
