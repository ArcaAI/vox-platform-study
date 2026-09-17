'use client';

/**
 * TASK-965 §3.1 — the console-wide lifecycle status badge.
 *
 * It renders the LABEL as text with the icon `aria-hidden`, so the state is never carried by
 * colour alone (WCAG 1.4.1) and a screen reader reads one word rather than a decorative glyph.
 * The badge is deliberately non-interactive: these render inside grid cells and inside rows that
 * are themselves buttons, where a focusable tooltip trigger would be interactive content nested
 * in a button — invalid HTML, and it swallows the row's accessible name. The longer meaning is a
 * `title` for pointer users (same reasoning as `ApprovalPin`).
 */
import { Badge, cn } from '@arcaai/ui';
import { LIFECYCLE_STATUS, isLifecycleStatus, lifecycleStatusLabel, type LifecycleStatus } from './lifecycle-status';

export interface LifecycleStatusBadgeProps {
  /** A `LifecycleStatus`, or any string a newer gateway might answer with. */
  status: LifecycleStatus | (string & {});
  /** Drop the icon where the row already carries one (dense grid cells). */
  showIcon?: boolean;
  className?: string;
}

export function LifecycleStatusBadge({ status, showIcon = true, className }: LifecycleStatusBadgeProps) {
  const meta = isLifecycleStatus(status) ? LIFECYCLE_STATUS[status] : undefined;
  const Icon = meta?.icon;

  return (
    <Badge variant={meta?.variant ?? 'outline'} className={cn('gap-1', meta?.className, className)} title={meta?.description}>
      {showIcon && Icon ? <Icon aria-hidden className="size-3" /> : null}
      {lifecycleStatusLabel(status)}
    </Badge>
  );
}
