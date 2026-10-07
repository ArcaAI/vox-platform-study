'use client';

import { IconShieldCheck } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { GuardrailCheckList } from './guardrail-check-list';
import { guardrailDirectionShortLabel } from './labels';
import { guardrailNoticeCopy, isWarningNotice, mergeGuardrailNotices, type GuardrailNotice } from './notice';

/** A notice as the consultation's `GET …/guardrail-notices` returns it: the v1 notice plus its state. */
export type GuardrailNoticeWithState = GuardrailNotice & {
  status?: 'open' | 'acknowledged' | 'resolved' | string;
  resolution?: string | null;
};

const TYPE_META: Record<GuardrailNotice['type'], { label: string; role: StatusColorRole }> = {
  'guardrail.warning': { label: 'Warning', role: 'warning' },
  'guardrail.unverified': { label: 'Unverified', role: 'info' },
  'guardrail.blocked': { label: 'Blocked', role: 'destructive' },
};

const STATUS_LABELS: Record<string, string> = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

/**
 * TASK-1050 W3b — every notice of a consultation (or a run), deduplicated by `noticeId`, with its state.
 * An OPEN warning that requires acknowledgement offers "Acknowledge"; a block is resumed, never
 * acknowledged here (acknowledging a block does not release its hold — the gateway says so too).
 */
export function GuardrailNoticeList({
  notices,
  onAcknowledge,
  pendingNoticeId = null,
  emptyText = 'No guardrail notices for this consultation.',
}: {
  notices: readonly GuardrailNoticeWithState[];
  onAcknowledge?: (noticeId: string) => void;
  pendingNoticeId?: string | null;
  emptyText?: string;
}) {
  const list = mergeGuardrailNotices([], notices);
  if (list.length === 0) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <IconShieldCheck aria-hidden className="size-4" />
        {emptyText}
      </p>
    );
  }
  return (
    <ul aria-label={`Guardrail notices (${list.length})`} className="flex flex-col gap-2">
      {list.map((notice) => {
        const meta = TYPE_META[notice.type] ?? { label: notice.type, role: 'neutral' as const };
        const status = notice.status ?? 'open';
        const canAcknowledge = !!onAcknowledge && status === 'open' && notice.requiresAcknowledgement && isWarningNotice(notice);
        return (
          <li key={notice.noticeId} className="flex flex-col gap-1.5 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge label={meta.label} colorRole={meta.role} />
              <span className="text-muted-foreground text-xs">{guardrailDirectionShortLabel(notice.direction)}</span>
              <span className="text-muted-foreground text-xs">{STATUS_LABELS[status] ?? status}</span>
              {notice.resolution ? <span className="text-muted-foreground font-mono text-xs">{notice.resolution}</span> : null}
              {canAcknowledge ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={pendingNoticeId !== null}
                  onClick={() => onAcknowledge?.(notice.noticeId)}
                >
                  {pendingNoticeId === notice.noticeId ? <Spinner /> : null}
                  Acknowledge
                </Button>
              ) : null}
            </div>
            <p className="text-sm">{guardrailNoticeCopy(notice)}</p>
            <GuardrailCheckList checks={notice.checks} />
          </li>
        );
      })}
    </ul>
  );
}
