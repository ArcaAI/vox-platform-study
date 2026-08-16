'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

/**
 * ConsultationStatus lifecycle -> semantic roles (frame 40: status is never
 * color-only — the label always rides along). Unknown values fall back to a
 * neutral badge with the raw label.
 *
 * TASK-711 — session state machine (state-machine.md §1/§2). `CLOSED` is
 * SUPERSEDED (never written by any live path) but kept mapped since a stale
 * historical row could in principle still carry it. `PRIMED`/`DRAINING` are
 * new mid-session phases; `TIMED_OUT` is the "clock never signs" terminal
 * (still rescuable via sign-off); `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE`
 * replace `CLOSED` as the two real terminal-close outcomes.
 */
const STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  OPEN: { label: 'Open', role: 'info' },
  PRIMED: { label: 'Primed', role: 'info' },
  RECORDING: { label: 'Recording', role: 'primary' },
  DRAINING: { label: 'Draining', role: 'primary' },
  DRAFT_PENDING_SENSORS: { label: 'Draft pending sensors', role: 'ai' },
  PENDING_REVIEW: { label: 'Pending review', role: 'warning' },
  SIGNED: { label: 'Signed', role: 'success' },
  TIMED_OUT: { label: 'Timed out', role: 'destructive' },
  CLOSED: { label: 'Closed', role: 'neutral' },
  REOPENED: { label: 'Reopened', role: 'hope' },
  CLOSED_COMPLETE: { label: 'Closed (signed)', role: 'success' },
  CLOSED_INCOMPLETE: { label: 'Closed (no sign-off)', role: 'neutral' },
};

export function ConsultationStatusBadge({ status }: { status: string | undefined }) {
  const meta = STATUS_META[status ?? ''] ?? { label: status || 'Unknown', role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
