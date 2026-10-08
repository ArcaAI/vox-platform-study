/**
 * TASK-1050 follow-up F — marking an output RELEASED BY AN OVERRIDE (README §9.7.4, §14.3 finding F).
 *
 * `guardrail-hold/resume` with `acknowledged` on an OUTBOUND block lets the withheld generation through
 * at warn weight. The released note is persisted LATER, by the paused node's re-run, as a new context
 * item — so the marker cannot be written at resume time; it is written when that item is created.
 * The persisting call (`HarnessInternalService.persistDraft`) hands the new item to
 * {@link markOverrideReleasedItem} inside its own transaction.
 *
 * Same marker rules as the evaluation ingest: the item given IS its current version, a stronger marker
 * (WARNED / BLOCKED / WITHHELD) is never downgraded, and `_version` is never touched (OD-21).
 */
import { GuardrailItemStatus, type ContextItemRepository, type GuardrailNoticeRepository } from '@arcaai/domains';
import { isRedactionHoldNotice } from './guardrail-hold.rules';
import { itemStatusRank } from './guardrail-wire';

export interface OverrideReleasedItem {
  id: string;
  tenantId: string;
  consultationId?: string | null;
  guardrailStatus?: string | null;
  /** When the item was persisted: an override resolved after it cannot have released it. */
  createdAt?: Date | string | null;
}

/**
 * Mark `item` WARNED when an `acknowledged` resolution of an outbound block released it. Returns
 * whether it wrote. `runId` (when the persisting call knows it) narrows the override to the run that
 * was paused on the notice, so an unrelated later generation is never marked.
 */
export async function markOverrideReleasedItem(
  deps: {
    notices: Pick<GuardrailNoticeRepository, 'findAll'>;
    contextItems: Pick<ContextItemRepository, 'setGuardrailStatus'>;
  },
  item: OverrideReleasedItem,
  scope: { runId?: string | null } = {},
  tx?: unknown,
): Promise<boolean> {
  if (!item.consultationId) return false;
  if (itemStatusRank(item.guardrailStatus) >= itemStatusRank(GuardrailItemStatus.WARNED)) return false;

  const rows = await deps.notices.findAll({
    where: {
      tenantId: item.tenantId,
      consultationId: item.consultationId,
      type: 'BLOCKED',
      direction: 'OUTBOUND',
      status: 'RESOLVED',
      resolution: 'acknowledged',
    } as never,
  });
  const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : Number.POSITIVE_INFINITY;
  const released = rows.some(
    (notice) =>
      notice.tenantId === item.tenantId &&
      notice.consultationId === item.consultationId &&
      !isRedactionHoldNotice(notice) &&
      (!scope.runId || !notice.runId || notice.runId === scope.runId) &&
      (!notice.resolvedAt || new Date(notice.resolvedAt).getTime() <= createdAt),
  );
  if (!released) return false;
  await deps.contextItems.setGuardrailStatus(item.id, GuardrailItemStatus.WARNED, tx as never);
  return true;
}
