'use client';

import { IconCircle, IconCircleCheck, IconCircleDot, IconTopologyStar3 } from '@tabler/icons-react';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useHarnessWorkflow } from '../api';
import type { HarnessWorkflowDetail } from '../api';
import { elapsedSeconds, formatDuration } from './format-duration';
import { workflowKind } from './workflow-kind';
import { WorkflowStatusBadge } from './workflow-status-badge';

/** Harness loop phases in execution order (HarnessWorkflowSummary.phase values). */
const LOOP_PHASES = ['NER', 'ASSEMBLE', 'GENERATE', 'SENSORS', 'GATE'] as const;

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-sm">{children}</dd>
        </div>
    );
}

/** Best-effort projection of a Temporal PendingActivityInfo proto-dict. */
function activityMeta(entry: unknown): { name: string; state: string | null; attempt: number | null } {
    if (!entry || typeof entry !== 'object') return { name: 'activity', state: null, attempt: null };
    const record = entry as Record<string, unknown>;
    const type = record.activityType;
    const name =
        type && typeof type === 'object' && typeof (type as Record<string, unknown>).name === 'string'
            ? ((type as Record<string, unknown>).name as string)
            : typeof record.activityId === 'string'
              ? record.activityId
              : 'activity';
    const state = typeof record.state === 'string' ? record.state.replace('PENDING_ACTIVITY_STATE_', '').toLowerCase() : null;
    const attempt = typeof record.attempt === 'number' ? record.attempt : null;
    return { name, state, attempt };
}

/**
 * The DTO carries no per-event history list (only historyLength +
 * pendingActivities + the loop phase), so HISTORY renders the phase checklist
 * with the current phase marked, plus any pending activities.
 */
function HistorySection({ detail }: { detail: HarnessWorkflowDetail }) {
    const phase = detail.phase?.toUpperCase() ?? null;
    const phaseIndex = phase ? (LOOP_PHASES as readonly string[]).indexOf(phase) : -1;
    const completed = detail.status.toUpperCase() === 'COMPLETED';
    const pending = (detail.pendingActivities ?? []).map(activityMeta);

    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">History</h3>
            {phase || completed ? (
                <ul className="flex flex-col gap-1" aria-label="Loop phases">
                    {LOOP_PHASES.map((name, index) => {
                        const isDone = completed || (phaseIndex >= 0 && index < phaseIndex);
                        const isCurrent = !completed && index === phaseIndex;
                        const Icon = isDone ? IconCircleCheck : isCurrent ? IconCircleDot : IconCircle;
                        return (
                            <li key={name} className="flex items-center gap-2 text-sm">
                                <Icon
                                    aria-hidden
                                    className={isDone ? 'text-success size-4' : isCurrent ? 'text-primary size-4' : 'text-muted-foreground size-4'}
                                />
                                <span className={isCurrent ? 'font-medium' : isDone ? '' : 'text-muted-foreground'}>
                                    {name.toLowerCase()}
                                    <span className="sr-only">{isDone ? ' (done)' : isCurrent ? ' (in progress)' : ' (not started)'}</span>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p className="text-muted-foreground text-sm">No loop phase reported for this workflow.</p>
            )}
            {pending.length > 0 ? (
                <ul className="flex flex-col gap-1" aria-label="Pending activities">
                    {pending.map((activity, index) => (
                        <li key={`${activity.name}-${index}`} className="text-muted-foreground text-xs">
                            <span className="font-mono">{activity.name}</span>
                            {activity.state ? ` \u00b7 ${activity.state}` : ''}
                            {activity.attempt !== null ? ` \u00b7 attempt ${formatNumber(activity.attempt)}` : ''}
                        </li>
                    ))}
                </ul>
            ) : null}
            {detail.historyLength !== null ? (
                <p className="text-muted-foreground text-xs tabular-nums">{formatNumber(detail.historyLength)} history events recorded</p>
            ) : null}
        </section>
    );
}

/**
 * Frame 38 panel (a) — the detail drawer for the selected workflow
 * (GET workflows/:id?phase=true): id, type, state, started + HISTORY.
 */
export function WorkflowDetailDrawer({ workflowId }: { workflowId: string | null }) {
    const detailQuery = useHarnessWorkflow(workflowId);
    const detail = detailQuery.data;
    const runtime = detail ? elapsedSeconds(detail.startedAt, detail.closeTime) : null;

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Detail</h2>
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET workflows/:id
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                {!workflowId ? (
                    <EmptyState
                        icon={IconTopologyStar3}
                        title="No workflow selected"
                        description="Click a row in the grid to inspect its state and history."
                    />
                ) : detailQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-32 w-full" />
                    </div>
                ) : detailQuery.error ? (
                    <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
                ) : detail ? (
                    <>
                        <div className="flex items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-sm" title={detail.workflowId}>
                                {detail.workflowId}
                            </span>
                            <CopyButton value={detail.workflowId} label="Copy workflow id" />
                        </div>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                            <MetaItem label="Type">{workflowKind(detail.workflowId)}</MetaItem>
                            <MetaItem label="State">
                                <WorkflowStatusBadge status={detail.status} />
                            </MetaItem>
                            <MetaItem label="Started">{formatDateTime(detail.startedAt)}</MetaItem>
                            <MetaItem label="Runtime">{runtime === null ? '\u2014' : formatDuration(runtime)}</MetaItem>
                            <MetaItem label="Consultation">
                                {detail.consultationId ? (
                                    <span className="block max-w-40 truncate font-mono text-xs" title={detail.consultationId}>
                                        {detail.consultationId}
                                    </span>
                                ) : (
                                    '\u2014'
                                )}
                            </MetaItem>
                            <MetaItem label="Run id">
                                {detail.runId ? (
                                    <span className="block max-w-40 truncate font-mono text-xs" title={detail.runId}>
                                        {detail.runId}
                                    </span>
                                ) : (
                                    '\u2014'
                                )}
                            </MetaItem>
                        </dl>
                        <HistorySection detail={detail} />
                    </>
                ) : null}
            </CardContent>
        </Card>
    );
}
