/**
 * TASK-1050 W2e — which consultation context items an LLM must never see again (README §9.7.5,
 * §9.7.6). Exactly two rules:
 *
 *  - `WITHHELD` is always skipped: an outbound-blocked placeholder carries no content, and the
 *    withheld text lives only encrypted on its evaluation row.
 *  - `BLOCKED` is skipped once a clinician resolved its hold as `item_excluded` — the exclusion is
 *    stored on the notice resolution, so it is read through the notice repository. A BLOCKED item
 *    that is not excluded stays in context: the next run re-screens it (and re-blocks), which is
 *    exactly why the hold asks the clinician to decide.
 *
 * Everything else (CLEAN, WARNED, an edited BLOCKED item's newer version) is ordinary context.
 */
import type { GuardrailNoticeRepository } from '@arcaai/domains';

export const GUARDRAIL_EXCLUDED_RESOLUTION = 'item_excluded';

/** The ids of every item a resolved `item_excluded` hold left out of later LLM context. */
export async function loadGuardrailExcludedItemIds(
  notices: Pick<GuardrailNoticeRepository, 'findAll'> | undefined,
  tenantId: string,
  consultationId: string,
): Promise<Set<string>> {
  if (!notices) return new Set();
  const rows = await notices.findAll({
    where: { tenantId, consultationId, status: 'RESOLVED', resolution: GUARDRAIL_EXCLUDED_RESOLUTION } as never,
  });
  return new Set(rows.flatMap((row: { itemIds?: string[] | null }) => row.itemIds ?? []));
}

/** Whether an item must be left out of every LLM context (`excluded` from {@link loadGuardrailExcludedItemIds}). */
export function isGuardrailExcludedItem(item: { id: string; guardrailStatus?: string | null }, excluded: ReadonlySet<string>): boolean {
  const status = String(item.guardrailStatus ?? 'CLEAN');
  if (status === 'WITHHELD') return true;
  return status === 'BLOCKED' && excluded.has(item.id);
}
