import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useAuditLog, type AuditLogEntry } from '@arcaai/vox';
import { Download, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { downloadTextFile, timestampedCsvName } from '@/features/users/download';
import { cn, formatDateTime } from '@/lib/utils';

const ACTION_VERB: Record<string, string> = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    LOGIN: 'Signed in',
    LOGOUT: 'Signed out',
    ASSIGN: 'Assigned',
    REMOVE: 'Removed',
};

function humanizeResource(resourceType?: string): string {
    if (!resourceType) return 'record';
    return resourceType
        .replace(/[._-]+/g, ' ')
        .toLowerCase()
        .trim();
}

function entryTitle(entry: AuditLogEntry): string {
    const action = String(entry.action ?? '').toUpperCase();
    if (action === 'LOGIN') return 'Signed in';
    if (action === 'LOGOUT') return 'Signed out';
    const verb = ACTION_VERB[action];
    const noun = humanizeResource(entry.resourceType);
    if (verb) return `${verb} ${noun}`;
    return entry.eventType || `${action || 'Event'} · ${noun}`;
}

function dotRole(entry: AuditLogEntry): string {
    if (entry.success === false) return 'bg-destructive';
    switch (String(entry.action ?? '').toUpperCase()) {
        case 'CREATE':
        case 'ASSIGN':
            return 'bg-success';
        case 'DELETE':
        case 'REMOVE':
            return 'bg-warning';
        case 'UPDATE':
            return 'bg-info';
        case 'LOGIN':
        case 'LOGOUT':
            return 'bg-primary';
        default:
            return 'bg-muted-foreground';
    }
}

function actorOf(entry: AuditLogEntry): string | undefined {
    return entry.responsibleUser?.displayName || entry.responsibleUser?.email || undefined;
}

/**
 * 38u **Activity** tab — REAL `useAuditLog.byUser` timeline + server-side CSV
 * export (`exportCsv({ userId })`). Titles are humanized from the entry
 * `action`/`resourceType`; the dot color is semantic (never color-only — each
 * row keeps its text label).
 */
export function ActivityPanel({ userId }: { userId: string }) {
    const { byUser, exportCsv } = useAuditLog();
    const [entries, setEntries] = useState<AuditLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [exporting, setExporting] = useState(false);

    const load = () => {
        setLoading(true);
        setError(null);
        byUser(userId)
            .then((items) => setEntries(items))
            .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]);

    const handleExport = async () => {
        setExporting(true);
        try {
            const csv = await exportCsv({ userId });
            downloadTextFile(timestampedCsvName(`user-${userId}-activity`), csv);
            toast.success('Activity exported');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to export activity');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">Activity history</h2>
                    <p className="text-sm text-muted-foreground">Audit-style events for this user across the platform.</p>
                </div>
                <Button variant="outline" size="sm" disabled={exporting || entries.length === 0} onClick={handleExport}>
                    <Download className="size-4" />
                    Export CSV
                </Button>
            </div>

            <Card className="p-5">
                {loading ? (
                    <div className="space-y-3">
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center gap-3 py-8 text-center">
                        <p className="text-sm text-muted-foreground">Couldn’t load activity.</p>
                        <Button variant="outline" size="sm" onClick={load}>
                            Retry
                        </Button>
                    </div>
                ) : entries.length === 0 ? (
                    <Empty>
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <History />
                            </EmptyMedia>
                            <EmptyTitle>No activity yet</EmptyTitle>
                            <EmptyDescription>Audit events for this user will appear here.</EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <ol className="relative space-y-5 border-l border-border pl-6">
                        {entries.map((entry) => {
                            const actor = actorOf(entry);
                            return (
                                <li key={entry.id} className="relative">
                                    <span className={cn('absolute -left-7 top-1.5 size-2.5 rounded-full ring-4 ring-background', dotRole(entry))} aria-hidden />
                                    <p className="text-sm font-medium text-foreground">{entryTitle(entry)}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {formatDateTime(entry.createdAt)}
                                        {actor ? ` · ${actor}` : ''}
                                        {entry.responsibleIp ? ` · ${entry.responsibleIp}` : ''}
                                    </p>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </Card>
        </div>
    );
}
