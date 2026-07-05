'use client';

import { IconAlertTriangle, IconClockPause } from '@tabler/icons-react';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useGateQueue } from '../api';
import { formatDuration } from './format-duration';

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-sm">{label}</dt>
            <dd className="text-sm font-medium tabular-nums">{children}</dd>
        </div>
    );
}

/**
 * Frame 37 panel (c) — pending clinician approvals with SLA posture. Strictly
 * read-only: decisions happen in the clinical apps, the board only observes
 * (pending {'\u2192'} approved {'\u2192'} edited).
 */
export function GateQueueCard() {
    const queueQuery = useGateQueue();
    const queue = queueQuery.data;
    const oldestWaitSeconds = queue && queue.items.length > 0 ? Math.max(...queue.items.map((item) => item.ageSeconds)) : null;

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Gate queue</h2>
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET gate-queue {'\u00b7'} read-only
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                {queueQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-24 w-full" />
                    </div>
                ) : queueQuery.error ? (
                    <ErrorState error={queueQuery.error} onRetry={() => void queueQuery.refetch()} />
                ) : queue ? (
                    <>
                        <dl className="flex flex-col gap-1.5">
                            <StatRow label="Pending">{formatNumber(queue.total)}</StatRow>
                            <StatRow label="Oldest">{oldestWaitSeconds === null ? '\u2014' : formatDuration(oldestWaitSeconds)}</StatRow>
                            <StatRow label="Breached SLA">
                                <span className="inline-flex items-center gap-1">
                                    {queue.slaBreachedCount > 0 ? <IconAlertTriangle aria-hidden className="text-warning size-3.5" /> : null}
                                    {formatNumber(queue.slaBreachedCount)}
                                </span>
                            </StatRow>
                            <StatRow label="Escalated">{formatNumber(queue.escalatedCount)}</StatRow>
                        </dl>
                        {queue.items.length === 0 ? (
                            <EmptyState icon={IconClockPause} title="No consultations awaiting review" description="The clinician gate queue is clear." />
                        ) : (
                            <ul className="flex flex-col gap-2" aria-label="Consultations awaiting review">
                                {queue.items.map((item) => (
                                    <li key={item.consultationId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-2">
                                        <span className="min-w-0">
                                            <span className="block max-w-40 truncate font-mono text-xs" title={item.consultationId}>
                                                {item.consultationId}
                                            </span>
                                            <span className="text-muted-foreground text-xs">
                                                waiting {formatDuration(item.ageSeconds)} {'\u00b7'} {formatNumber(item.regenCount)} regen
                                            </span>
                                        </span>
                                        {item.escalated ? (
                                            <StatusBadge label="Escalated" colorRole="destructive" icon={<IconAlertTriangle aria-hidden />} />
                                        ) : item.slaBreached ? (
                                            <StatusBadge label="SLA breached" colorRole="warning" icon={<IconAlertTriangle aria-hidden />} />
                                        ) : (
                                            <StatusBadge label="In SLA" colorRole="neutral" icon={<IconClockPause aria-hidden />} />
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="text-muted-foreground text-xs">
                            Board flows pending {'\u2192'} approved {'\u2192'} edited {'\u00b7'} SLA {formatDuration(queue.gateSlaSeconds)},
                            escalation {formatDuration(queue.gateEscalationSeconds)} ({queue.policySource})
                        </p>
                    </>
                ) : null}
            </CardContent>
        </Card>
    );
}
