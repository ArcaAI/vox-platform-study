'use client';

import { IconRefresh, IconShieldX } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import type { GuardrailHoldResolution } from '@arcaai/types';
import { GuardrailCheckList } from './guardrail-check-list';
import { HOLD_RESOLUTION_LABELS, REDACTION_RETRY_LABEL, guardrailDirectionLabel, legacyBlockCopy } from './labels';
import { allowedHoldResolutions, guardrailNoticeCopy, isRedactionUnavailableNotice, type GuardrailNotice } from './notice';

/**
 * TASK-1050 W3b — a BLOCK, designed as a panel rather than a toast (the `FailClosedPanel` idea of the
 * LLM playground, made shared). It names the check(s) and the direction, shows the copy keyed by
 * `messageKey`, and — when the notice is resumable and the caller can resume — offers ONLY the allowed
 * resolutions (README §9.8.1: no dead ends; the locked medical check never offers the override).
 *
 * With no notice (an older gateway relays only the legacy `CONTENT_BLOCKED*` code) it still renders a
 * useful, generic explanation.
 */
export function GuardrailBlockPanel({
  notice,
  code,
  title,
  onResume,
  resumePending = false,
  pendingResolution,
  onRetry,
  retryLabel = 'Retry',
  className,
}: {
  notice: GuardrailNotice | null;
  /** The legacy error code, for a block that arrived without a notice. */
  code?: string | null;
  title?: string;
  /** Resolve the hold (the consultation surfaces). Absent ⇒ no resume actions. */
  onResume?: (resolution: GuardrailHoldResolution) => void;
  resumePending?: boolean;
  pendingResolution?: GuardrailHoldResolution['resolution'] | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const resolutions = notice && onResume ? allowedHoldResolutions(notice) : [];
  const redaction = notice ? isRedactionUnavailableNotice(notice) : false;
  const heading =
    title ??
    (redaction
      ? 'Processing paused: patient details could not be protected'
      : notice?.direction === 'outbound'
        ? 'A safety check withheld the generated content'
        : 'A safety check stopped this request');

  return (
    <div role="alert" data-slot="guardrail-block-panel" className={`bg-destructive/5 flex flex-col gap-2 rounded-lg border border-destructive/30 p-4 ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <IconShieldX aria-hidden className="text-destructive size-4 shrink-0" />
        <p className="text-destructive text-sm font-medium">{heading}</p>
      </div>
      <p className="text-sm">{notice ? guardrailNoticeCopy(notice) : legacyBlockCopy(code)}</p>
      {notice ? <p className="text-muted-foreground text-xs">{guardrailDirectionLabel(notice.direction)}</p> : null}
      {notice ? <GuardrailCheckList checks={notice.checks} /> : null}
      {!notice && code ? <p className="text-muted-foreground font-mono text-xs">{code}</p> : null}
      {resolutions.length > 0 || onRetry ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {resolutions.map((resolution) => (
            <Button
              key={resolution}
              type="button"
              size="sm"
              variant={resolution === 'item_excluded' || redaction ? 'default' : 'outline'}
              disabled={resumePending}
              onClick={() => notice && onResume?.({ noticeId: notice.noticeId, resolution })}
            >
              {resumePending && pendingResolution === resolution ? <Spinner /> : null}
              {redaction ? REDACTION_RETRY_LABEL : HOLD_RESOLUTION_LABELS[resolution]}
            </Button>
          ))}
          {onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              <IconRefresh aria-hidden />
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
