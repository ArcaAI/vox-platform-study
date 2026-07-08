'use client';

import { IconHistory } from '@tabler/icons-react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSettingHistory } from '../api/hooks';

/**
 * Read-only change history for a setting (TASK-439, Open-item 2). There is no
 * versions endpoint, so this reads the audit log
 * (`GET /admin/audit-logs/resource/GlobalSetting/:id`) and lists actor · action ·
 * when · version. `active` gates the fetch to when the History tab is shown.
 */
export function SettingHistoryTab({ settingId, active }: { settingId: string; active: boolean }) {
    const history = useSettingHistory(settingId, active);

    if (history.isPending) {
        return (
            <div className="flex flex-col gap-2" aria-hidden>
                {[0, 1, 2].map((row) => (
                    <div key={row} className="flex items-center justify-between gap-3">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-4 w-20" />
                    </div>
                ))}
            </div>
        );
    }

    if (history.error) {
        return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
    }

    const entries = history.data ?? [];
    if (entries.length === 0) {
        return <EmptyState icon={IconHistory} title="No history yet" description="Changes to this setting are recorded in the audit log and appear here." />;
    }

    return (
        <ol className="flex flex-col gap-3" aria-label="Change history">
            {entries.map((entry) => {
                const actor = entry.responsibleUser?.displayName || entry.responsibleUser?.email || entry.responsibleUserId || 'System';
                return (
                    <li key={entry.id} className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium">{entry.action}</span>
                            <span className="text-muted-foreground truncate text-xs">{actor}</span>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                            <span className="text-muted-foreground">{formatRelativeTime(entry.createdAt)}</span>
                            {entry.version !== null ? <span className="text-muted-foreground font-mono">v{entry.version}</span> : null}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
