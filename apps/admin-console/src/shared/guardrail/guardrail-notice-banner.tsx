'use client';

import type { ReactNode } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { GuardrailCheckList } from './guardrail-check-list';
import { guardrailDirectionShortLabel } from './labels';
import { guardrailNoticeCopy, isWarningNotice, mergeGuardrailNotices, toGuardrailNotice, type GuardrailNotice } from './notice';

/**
 * TASK-1050 W3b — a WARN (or an unverified check): the operation continued, and the user is told which
 * checks flagged it and in which category. Copy comes from `messageKey`; content and judge reasoning
 * never appear (README §9.7.3). The output it sits above stays visible.
 *
 * A polite `status` region, not an `alert`: a live summary may add a notice every few seconds and must
 * not interrupt a screen reader each time.
 */
export function GuardrailNoticeBanner({
  notices,
  title = 'Safety check warning',
  actions,
  className,
}: {
  notices: readonly GuardrailNotice[];
  title?: string;
  /** e.g. an Acknowledge button. */
  actions?: ReactNode;
  className?: string;
}) {
  const valid = mergeGuardrailNotices(
    [],
    notices.flatMap((notice) => {
      const checked = toGuardrailNotice(notice);
      return checked && isWarningNotice(checked) ? [checked] : [];
    }),
  );
  if (valid.length === 0) return null;
  return (
    <Alert role="status" data-slot="guardrail-notice-banner" className={`border-warning/40 bg-warning/10 ${className ?? ''}`}>
      <IconAlertTriangle aria-hidden className="text-warning" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-foreground flex flex-col gap-3">
        {valid.map((notice) => (
          <div key={notice.noticeId} className="flex flex-col gap-1.5">
            <p>{guardrailNoticeCopy(notice)}</p>
            <p className="text-muted-foreground text-xs">{`${guardrailDirectionShortLabel(notice.direction)} check`}</p>
            <GuardrailCheckList checks={notice.checks} />
          </div>
        ))}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
