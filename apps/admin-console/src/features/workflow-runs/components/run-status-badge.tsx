'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { WorkflowRunStatus } from '../api/types';

/**
 * `WorkflowRunStatus` -> semantic role (never color alone, rule 11 §7).
 * Deliberately NO `DEGRADED` entry (README pitfall 6) — degradation is a
 * count/flag on the run row (`degradedNodeCount`), never a run status.
 */
const RUN_STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  RUNNING: { label: 'Running', role: 'primary' },
  COMPLETED: { label: 'Completed', role: 'success' },
  FAILED: { label: 'Failed', role: 'destructive' },
  CANCELED: { label: 'Canceled', role: 'neutral' },
  TIMED_OUT: { label: 'Timed out', role: 'warning' },
};

export function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  const meta = RUN_STATUS_META[status.toUpperCase()] ?? { label: status, role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
