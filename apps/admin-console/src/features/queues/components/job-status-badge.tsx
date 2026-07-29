'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

/** BullMQ job states -> semantic roles (frame 17: state is never color-only). */
const JOB_STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  waiting: { label: 'Waiting', role: 'info' },
  active: { label: 'Active', role: 'primary' },
  completed: { label: 'Completed', role: 'success' },
  failed: { label: 'Failed', role: 'destructive' },
  delayed: { label: 'Delayed', role: 'warning' },
  paused: { label: 'Paused', role: 'neutral' },
  prioritized: { label: 'Prioritized', role: 'ai' },
};

export function JobStatusBadge({ status }: { status: string }) {
  const meta = JOB_STATUS_META[status.toLowerCase()] ?? { label: status, role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
