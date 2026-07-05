'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';

/** Frame 18 Result cell: dot + label (never color-only); null = not recorded. */
export function AuditResultIndicator({ success }: { success: boolean | null }) {
    if (success === null) return <span className="text-muted-foreground">{'\u2014'}</span>;
    return <StatusDot colorRole={success ? 'success' : 'destructive'} label={success ? 'OK' : 'Fail'} />;
}
