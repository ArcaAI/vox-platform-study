'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

/**
 * ConsultationStatus lifecycle -> semantic roles (frame 40: status is never
 * color-only — the label always rides along). Unknown values (legacy
 * metadata.status strings) fall back to a neutral badge with the raw label.
 */
const STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  OPEN: { label: 'Open', role: 'info' },
  RECORDING: { label: 'Recording', role: 'primary' },
  DRAFT_PENDING_SENSORS: { label: 'Draft pending sensors', role: 'ai' },
  PENDING_REVIEW: { label: 'Pending review', role: 'warning' },
  SIGNED: { label: 'Signed', role: 'success' },
  CLOSED: { label: 'Closed', role: 'neutral' },
  REOPENED: { label: 'Reopened', role: 'hope' },
};

export function ConsultationStatusBadge({ status }: { status: string | undefined }) {
  const meta = STATUS_META[status ?? ''] ?? { label: status || 'Unknown', role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
