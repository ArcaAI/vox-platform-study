'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { formatRelativeTime } from '@/shared/format';
import type { AiModelAvailability } from '../api/types';

/** Never color-only (rule 11 §10): each state carries its own label + role. */
export const AVAILABILITY_META: Record<AiModelAvailability, { label: string; role: StatusColorRole }> = {
  AVAILABLE: { label: 'Available', role: 'success' },
  MISSING: { label: 'Missing', role: 'destructive' },
  PARTIAL: { label: 'Partial', role: 'warning' },
  NOT_APPLICABLE: { label: 'Not applicable', role: 'neutral' },
  UNKNOWN: { label: 'Not inventoried', role: 'neutral' },
};

/**
 * MEASURED presence of a row's weights in the bucket (TASK-860 R-2) — written by
 * the inventory job, never declared by an admin — with when it was last checked.
 */
export function AvailabilityBadge({ availability, checkedAt }: { availability: AiModelAvailability; checkedAt?: string | null }) {
  const meta = AVAILABILITY_META[availability];
  return (
    <span className="flex items-center gap-1.5">
      <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
      {checkedAt ? <span className="text-muted-foreground text-xs">{formatRelativeTime(checkedAt)}</span> : null}
    </span>
  );
}
