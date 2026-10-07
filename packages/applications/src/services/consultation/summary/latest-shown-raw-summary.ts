import { ContextItemType, type ContextItemEntity, type ContextItemRepository } from '@arcaai/domains';

/**
 * TASK-1050 §9.7.6 — the consultation's latest AI note, skipping a WITHHELD placeholder (the empty
 * row an outbound-blocked generation leaves). Approve never signs one and the summary read never
 * answers one: the withheld text exists only encrypted on its guardrail evaluation.
 */
export async function latestShownRawSummary(
  repository: Pick<ContextItemRepository, 'findLatestRawSummary' | 'findByType'>,
  consultationId: string,
): Promise<ContextItemEntity | null> {
  const latest = await repository.findLatestRawSummary(consultationId);
  if (!latest || !isWithheld(latest)) return latest;
  const shown = (await repository.findByType(consultationId, ContextItemType.RAW_SUMMARY)).filter((item) => !isWithheld(item));
  shown.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return shown[0] ?? null;
}

function isWithheld(item: { guardrailStatus?: string | null }): boolean {
  return String(item.guardrailStatus ?? 'CLEAN') === 'WITHHELD';
}
