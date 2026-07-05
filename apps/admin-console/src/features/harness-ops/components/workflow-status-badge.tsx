'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

/** Temporal execution statuses -> semantic roles (frame 38: never color alone). */
const WORKFLOW_STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
    RUNNING: { label: 'Running', role: 'primary' },
    COMPLETED: { label: 'Completed', role: 'success' },
    FAILED: { label: 'Failed', role: 'destructive' },
    CANCELED: { label: 'Canceled', role: 'neutral' },
    TERMINATED: { label: 'Terminated', role: 'destructive' },
    TIMED_OUT: { label: 'Timed out', role: 'warning' },
    CONTINUED_AS_NEW: { label: 'Continued', role: 'info' },
};

export function WorkflowStatusBadge({ status }: { status: string }) {
    const meta = WORKFLOW_STATUS_META[status.toUpperCase()] ?? { label: status, role: 'neutral' as StatusColorRole };
    return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
