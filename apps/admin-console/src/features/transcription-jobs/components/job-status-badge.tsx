'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { TranscriptionJobStatus } from '../api';

/** Frame 35 wording (Running/Done) — state is never color-only, the label rides along. */
export const JOB_STATUS_META: Record<TranscriptionJobStatus, { label: string; role: StatusColorRole }> = {
  QUEUED: { label: 'Queued', role: 'info' },
  PROCESSING: { label: 'Running', role: 'primary' },
  COMPLETED: { label: 'Done', role: 'success' },
  FAILED: { label: 'Failed', role: 'destructive' },
  CANCELLED: { label: 'Cancelled', role: 'neutral' },
  DEAD: { label: 'Dead', role: 'destructive' },
};

export function TranscriptionJobStatusBadge({ status }: { status: TranscriptionJobStatus | string }) {
  const meta = JOB_STATUS_META[status as TranscriptionJobStatus] ?? { label: status, role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
