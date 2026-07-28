'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { ResourceStatus } from '@/shared/api';

/** Frame 34 grid status: On/Off wording (toggle flips ENABLED <-> DISABLED), never color-only. */
const PIPELINE_STATUS_META: Record<ResourceStatus, { label: string; role: StatusColorRole }> = {
  ENABLED: { label: 'On', role: 'success' },
  DISABLED: { label: 'Off', role: 'neutral' },
  SUSPENDED: { label: 'Suspended', role: 'warning' },
  ARCHIVED: { label: 'Archived', role: 'neutral' },
  DELETED: { label: 'Deleted', role: 'destructive' },
};

export function PipelineStatusBadge({ status }: { status: ResourceStatus | string | null | undefined }) {
  const meta = (status && PIPELINE_STATUS_META[status as ResourceStatus]) || { label: status ?? 'Unknown', role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
