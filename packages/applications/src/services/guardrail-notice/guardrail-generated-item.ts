/**
 * TASK-1050 finding D (round 2) — marking an output item created AFTER its generation answered.
 *
 * Most gateway → TEXT callers create the item the output becomes (a PRE_SUMMARY, a RAW_SUMMARY, a
 * FACT_LEDGER, the live lane's first snapshot) only once TEXT has answered, so the generation could
 * name no `response_items` and the evaluation ingest has nothing to mark. TEXT returns the outbound
 * notices synchronously with each generation (`guardrail_notices`); the creating call hands them, with
 * the new item, to {@link markGeneratedItemFromNotices} — inside its own transaction when it has one.
 *
 * Same marker rules as the ingest and {@link markOverrideReleasedItem}: the item given IS its current
 * content version (it was just written), a stronger marker is never downgraded, only the status column
 * is written (no `_version` bump). An OUTBOUND `guardrail.warning` → WARNED; `guardrail.unverified`
 * adds no marker; a block produced no output, so there is no item to mark.
 */
import { GUARDRAIL_NOTICE_TYPES, type GuardrailNotice } from '@arcaai/types';
import { GuardrailItemStatus, type ContextItemRepository } from '@arcaai/domains';
import { itemStatusRank } from './guardrail-wire';

export interface GeneratedItem {
  id: string;
  consultationId?: string | null;
  guardrailStatus?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotice(value: unknown): value is GuardrailNotice {
  return (
    isRecord(value) &&
    typeof value.noticeId === 'string' &&
    value.noticeId.length > 0 &&
    (GUARDRAIL_NOTICE_TYPES as readonly unknown[]).includes(value.type) &&
    typeof value.messageKey === 'string'
  );
}

/** The notices on a TEXT `/generate` 200 body (`guardrail_notices`, or the camel-cased `guardrailNotices`). */
export function textGenerationNotices(data: unknown): GuardrailNotice[] {
  if (!isRecord(data)) return [];
  const raw = data.guardrail_notices ?? data.guardrailNotices;
  return Array.isArray(raw) ? raw.filter(isNotice) : [];
}

/** Does `notice` warn about the OUTPUT that became `item`? */
function warnsAboutOutput(notice: GuardrailNotice, item: GeneratedItem): boolean {
  if (notice.type !== 'guardrail.warning' || notice.direction !== 'outbound') return false;
  if (notice.consultationId && item.consultationId && notice.consultationId !== item.consultationId) return false;
  // A notice that names items speaks for those items only; one that names none is about this output.
  return notice.itemIds.length === 0 || notice.itemIds.includes(item.id);
}

/** Mark `item` WARNED when the generation it came from raised an outbound warning. Returns whether it wrote. */
export async function markGeneratedItemFromNotices(
  deps: { contextItems: Pick<ContextItemRepository, 'setGuardrailStatus'> },
  item: GeneratedItem,
  notices: readonly GuardrailNotice[] | null | undefined,
  tx?: unknown,
): Promise<boolean> {
  if (!notices || notices.length === 0) return false;
  if (itemStatusRank(item.guardrailStatus) >= itemStatusRank(GuardrailItemStatus.WARNED)) return false;
  if (!notices.some((notice) => warnsAboutOutput(notice, item))) return false;
  await deps.contextItems.setGuardrailStatus(item.id, GuardrailItemStatus.WARNED, tx as never);
  return true;
}
