'use client';

import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import type { ResourceStatus } from '@/shared/api';

/**
 * Shared status rendering for the gateway's ResourceStatus enum (frames 01/04:
 * status = dot shape + label, never color alone). Domain-specific statuses
 * (queue health, job states...) map their own roles and reuse StatusBadge.
 */
export const RESOURCE_STATUS_META: Record<ResourceStatus, { label: string; role: StatusColorRole }> = {
    ENABLED: { label: 'Active', role: 'success' },
    DISABLED: { label: 'Disabled', role: 'neutral' },
    SUSPENDED: { label: 'Suspended', role: 'warning' },
    ARCHIVED: { label: 'Archived', role: 'neutral' },
    DELETED: { label: 'Deleted', role: 'destructive' },
};

export function ResourceStatusBadge({ status }: { status: ResourceStatus | string | null | undefined }) {
    const meta = (status && RESOURCE_STATUS_META[status as ResourceStatus]) || { label: status ?? 'Unknown', role: 'neutral' as StatusColorRole };
    return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
