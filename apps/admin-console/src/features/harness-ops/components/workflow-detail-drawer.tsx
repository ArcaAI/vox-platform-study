'use client';

import { useState } from 'react';
import { IconBan, IconBolt, IconCircle, IconCircleCheck, IconCircleDot, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useCancelWorkflow, useHarnessWorkflow, useTerminateWorkflow } from '../api';
import type { HarnessWorkflowDetail } from '../api';
import { elapsedSeconds, formatDuration } from './format-duration';
import { SignalDialog } from './signal-dialog';
import { workflowKind } from './workflow-kind';
import { WorkflowStatusBadge } from './workflow-status-badge';

type LifecycleAction = 'signal' | 'cancel' | 'terminate';

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
                            {activity.state ? ` · ${activity.state}` : ''}
                            {activity.attempt !== null ? ` · attempt ${formatNumber(activity.attempt)}` : ''}
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

function DetailBody({ detail }: { detail: HarnessWorkflowDetail }) {
    const runtime = elapsedSeconds(detail.startedAt, detail.closeTime);
    return (
        <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <MetaItem label="Type">{workflowKind(detail.workflowId)}</MetaItem>
                <MetaItem label="State">
                    <WorkflowStatusBadge status={detail.status} />
                </MetaItem>
                <MetaItem label="Started">{formatDateTime(detail.startedAt)}</MetaItem>
                <MetaItem label="Runtime">{runtime === null ? '—' : formatDuration(runtime)}</MetaItem>
                <MetaItem label="Consultation">
                    {detail.consultationId ? (
                        <span className="block max-w-40 truncate font-mono text-xs" title={detail.consultationId}>
                            {detail.consultationId}
                        </span>
                    ) : (
                        '—'
                    )}
                </MetaItem>
                <MetaItem label="Run id">
                    {detail.runId ? (
                        <span className="block max-w-40 truncate font-mono text-xs" title={detail.runId}>
                            {detail.runId}
                        </span>
                    ) : (
                        '—'
                    )}
                </MetaItem>
            </dl>
            <HistorySection detail={detail} />
        </div>
    );
}

/**
 * Frame 38 — the console-wide detail slide-over for the selected workflow
 * (GET workflows/:id?phase=true): id, type, state, started + the loop-phase
 * HISTORY, with the signal / cancel / terminate lifecycle controls folded into
 * the footer (each behind its own confirmation posture). Opens off the
 * `?workflow=` selection param; a right slide-over on desktop, full-screen on
 * mobile. The detail read self-polls while its run is live.
 */
export function WorkflowDetailDrawer({ workflowId, onOpenChange }: { workflowId: string | null; onOpenChange: (open: boolean) => void }) {
    const open = workflowId !== null;
    const detailQuery = useHarnessWorkflow(workflowId);
    const detail = detailQuery.data ?? null;
    const cancel = useCancelWorkflow();
    const terminate = useTerminateWorkflow();
    const [action, setAction] = useState<LifecycleAction | null>(null);

    function handleCancelConfirmed() {
        if (!workflowId) return;
        cancel.mutate(
            { workflowId },
            {
                onSuccess: () => {
                    toast.success(`Cancellation requested for ${workflowId}`);
                    setAction(null);
                },
                onError: (error) => {
                    toast.error(error instanceof GatewayError ? error.message : 'Could not cancel the workflow.');
                    setAction(null);
                },
            },
        );
    }

    function handleTerminateConfirmed() {
        if (!workflowId) return;
        terminate.mutate(
            { workflowId },
            {
                onSuccess: () => {
                    toast.success(`${workflowId} terminated`);
                    setAction(null);
                },
                onError: (error) => {
                    toast.error(error instanceof GatewayError ? error.message : 'Could not terminate the workflow.');
                    setAction(null);
                },
            },
        );
    }

    return (
        <>
            <DetailDrawer
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title={<span className="min-w-0 truncate font-mono text-sm">{detail?.workflowId ?? workflowId ?? 'Workflow'}</span>}
                badges={detail ? <WorkflowStatusBadge status={detail.status} /> : null}
                meta={
                    workflowId ? (
                        <>
                            <span>{detail ? workflowKind(detail.workflowId) : workflowKind(workflowId)}</span>
                            {detail?.startedAt ? (
                                <>
                                    <span aria-hidden>&middot;</span>
                                    <span>Started {formatRelativeTime(detail.startedAt)}</span>
                                </>
                            ) : null}
                            <CopyButton value={workflowId} label="Copy workflow id" />
                        </>
                    ) : null
                }
                footer={
                    workflowId ? (
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={() => setAction('signal')}>
                                <IconBolt aria-hidden />
                                Signal
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setAction('cancel')}>
                                <IconBan aria-hidden />
                                Cancel
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => setAction('terminate')}>
                                <IconX aria-hidden />
                                Terminate
                            </Button>
                        </div>
                    ) : null
                }
            >
                {!open ? null : detailQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-32 w-full" />
                    </div>
                ) : detailQuery.error ? (
                    <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
                ) : detail ? (
                    <DetailBody detail={detail} />
                ) : null}
            </DetailDrawer>

            <SignalDialog workflowId={workflowId} open={action === 'signal'} onOpenChange={(next) => setAction(next ? 'signal' : null)} />
            <ConfirmDialog
                open={action === 'cancel'}
                onOpenChange={(next) => setAction(next ? 'cancel' : null)}
                title="Cancel workflow?"
                description={`Requests a graceful Temporal cancellation for ${workflowId ?? ''}. In-flight activities finish before the workflow unwinds.`}
                confirmLabel="Cancel workflow"
                isPending={cancel.isPending}
                onConfirm={handleCancelConfirmed}
            />
            <ConfirmDialog
                open={action === 'terminate'}
                onOpenChange={(next) => setAction(next ? 'terminate' : null)}
                title="Terminate workflow?"
                description={`Forcefully terminates ${workflowId ?? ''} with no cleanup — running activities are abandoned. This cannot be undone.`}
                confirmLabel="Terminate workflow"
                destructive
                typeToConfirm={workflowId ?? undefined}
                isPending={terminate.isPending}
                onConfirm={handleTerminateConfirmed}
            />
        </>
    );
}
