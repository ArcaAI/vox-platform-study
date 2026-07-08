'use client';

import { IconAlertTriangle, IconChevronDown, IconPlayerStop, IconPlugConnected, IconRefresh, IconSparkles } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber } from '@/shared/format';
import type { TaskStreamState } from '../api/use-task-stream';
import type { AssembledDebugMeta, GenerateTextResponse, SmrTask, SmrTokenUsage } from '../api/types';

/** What the output pane is currently showing (screen-owned). */
export type RunState =
    | { kind: 'idle' }
    | { kind: 'sync'; result: GenerateTextResponse; debug?: AssembledDebugMeta }
    | { kind: 'stream'; taskId: string }
    | { kind: 'fail-closed'; message: string };

interface OutputPaneProps {
    run: RunState;
    stream: TaskStreamState;
    /** Generate POST in flight (sync ack not yet received). */
    isPending: boolean;
    /** Post-mortem GET /text/tasks/:taskId after a transport drop. */
    postMortem: SmrTask | undefined;
    onCancel: () => void;
    cancelPending: boolean;
    onRetry: () => void;
    onReattach: () => void;
}

function streamStatusChip(status: TaskStreamState['status']) {
    switch (status) {
        case 'connecting':
        case 'streaming':
            return <StatusBadge label="Task running" colorRole="ai" />;
        case 'done':
            return <StatusBadge label="Done" colorRole="success" />;
        case 'failed':
            return <StatusBadge label="Failed" colorRole="destructive" />;
        case 'error':
            return <StatusBadge label="Dropped" colorRole="warning" />;
        case 'closed':
            return <StatusBadge label="Cancelled" colorRole="neutral" />;
        default:
            return null;
    }
}

function ResultSummary({
    usage,
    latencyMs,
    finishReason,
    providerModel,
}: {
    usage?: SmrTokenUsage | null;
    latencyMs?: number;
    finishReason?: string | null;
    providerModel?: string;
}) {
    return (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {usage ? (
                <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Usage</dt>
                    <dd className="text-right font-mono text-xs">{`${usage.prompt_tokens} prompt · ${usage.completion_tokens} completion · ${usage.total_tokens} total`}</dd>
                </div>
            ) : null}
            {latencyMs !== undefined ? (
                <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Latency</dt>
                    <dd className="text-right font-mono text-xs">{`${formatNumber(latencyMs)} ms`}</dd>
                </div>
            ) : null}
            {finishReason ? (
                <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Finish reason</dt>
                    <dd>
                        <Badge variant="outline">{finishReason}</Badge>
                    </dd>
                </div>
            ) : null}
            {providerModel ? (
                <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Provider · model</dt>
                    <dd className="text-right font-mono text-xs">{providerModel}</dd>
                </div>
            ) : null}
        </dl>
    );
}

/** Admin-only `_debug` assembly meta (debug: true on /text/generate/assembled). */
function AssemblyMetaPanel({ debug }: { debug: AssembledDebugMeta }) {
    const rows: Array<[string, string | undefined]> = [
        ['Type', debug.type],
        ['Visit type', debug.visit_type],
        ['Template', debug.prompt_template_name],
        ['Template ID', debug.prompt_template_id],
        ['DNA style ID', debug.dna_writing_style_id],
        ['Context items', debug.context_item_ids?.join(', ')],
        ['Prompt length', String(debug.prompt_length)],
        ['System prompt length', String(debug.system_prompt_length)],
    ];
    return (
        <Collapsible defaultOpen className="rounded-md border">
            <CollapsibleTrigger className="focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 rounded-md p-3 text-sm font-medium outline-none focus-visible:ring-[3px]">
                Assembly meta
                <IconChevronDown aria-hidden className="size-4" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-3">
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    {rows
                        .filter(([, value]) => value !== undefined && value !== '')
                        .map(([label, value]) => (
                            <div key={label} className="flex items-baseline justify-between gap-3">
                                <dt className="text-muted-foreground">{label}</dt>
                                <dd className="text-right font-mono text-xs">{value}</dd>
                            </div>
                        ))}
                </dl>
            </CollapsibleContent>
        </Collapsible>
    );
}

/** Designed 422 error variant: SMR failed CLOSED — no toast, a real panel. */
function FailClosedPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div role="alert" className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-4">
            <div className="flex items-center gap-2">
                <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
                <p className="text-destructive text-sm font-semibold">422 — SMR fail-closed</p>
            </div>
            <p className="text-sm font-medium">No model resolved for this tenant.</p>
            <p className="text-muted-foreground text-sm">{message}</p>
            <p className="text-muted-foreground text-xs">
                Provider and model were omitted and the tenant’s HarnessPolicy cascade produced no effective model — SMR refuses to guess. Pick an
                explicit provider/model or fix the tenant policy.
            </p>
            <div>
                <Button variant="outline" size="sm" onClick={onRetry}>
                    <IconRefresh aria-hidden />
                    Retry
                </Button>
            </div>
        </div>
    );
}

export function OutputPane({ run, stream, isPending, postMortem, onCancel, cancelPending, onRetry, onReattach }: OutputPaneProps) {
    const isStreamRun = run.kind === 'stream';
    const streamLive = isStreamRun && (stream.status === 'connecting' || stream.status === 'streaming');
    // Recovery variant: the transport dropped but the task COMPLETED upstream —
    // the post-mortem read supersedes the drop alert and reattach affordance.
    const recovered = isStreamRun && stream.status === 'error' && postMortem?.status === 'completed' ? postMortem : undefined;

    return (
        <Card className="gap-4">
            <CardHeader>
                <CardTitle>Response</CardTitle>
                <CardDescription>SSE /text/tasks/:taskId/stream — same-origin via the BFF proxy, cookie auth</CardDescription>
                <CardAction>
                    <div className="flex items-center gap-2">
                        <div role="status" className="flex items-center gap-2">
                            {isStreamRun ? (recovered ? <StatusBadge label="Done" colorRole="success" /> : streamStatusChip(stream.status)) : null}
                            {run.kind === 'sync' ? <StatusBadge label="Done" colorRole="success" /> : null}
                            {run.kind === 'sync' && run.debug ? <StatusBadge label="Debug" colorRole="ai" /> : null}
                            {isStreamRun && stream.chunkCount > 0 ? <StatusBadge label={`${stream.chunkCount} tokens`} colorRole="neutral" /> : null}
                        </div>
                        {streamLive ? (
                            <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelPending}>
                                <IconPlayerStop aria-hidden />
                                Cancel
                            </Button>
                        ) : null}
                    </div>
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {isPending ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                ) : run.kind === 'idle' ? (
                    <EmptyOutput />
                ) : run.kind === 'fail-closed' ? (
                    <FailClosedPanel message={run.message} onRetry={onRetry} />
                ) : run.kind === 'sync' ? (
                    <>
                        <p className="bg-muted/30 min-h-24 rounded-md border p-3 font-mono text-sm whitespace-pre-wrap">{run.result.content}</p>
                        <ResultSummary
                            usage={run.result.usage}
                            latencyMs={run.result.latency_ms}
                            finishReason={run.result.finish_reason}
                            providerModel={`${run.result.provider} · ${run.result.model}`}
                        />
                        {run.debug ? <AssemblyMetaPanel debug={run.debug} /> : null}
                    </>
                ) : (
                    <>
                        <p className="bg-muted/30 min-h-24 rounded-md border p-3 font-mono text-sm whitespace-pre-wrap">
                            {recovered ? recovered.content : stream.content}
                            {streamLive ? (
                                <span aria-hidden className="text-primary animate-pulse">
                                    ▍
                                </span>
                            ) : null}
                        </p>
                        {stream.status === 'failed' ? (
                            <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm">
                                <p className="text-destructive">{`Upstream failure: ${stream.error ?? 'unknown error'}`}</p>
                            </div>
                        ) : null}
                        {recovered ? (
                            <>
                                <ResultSummary usage={recovered.usage} providerModel={`${recovered.provider} · ${recovered.model}`} />
                                <p className="text-muted-foreground font-mono text-xs">
                                    {`Stream dropped after completion — content recovered via GET /text/tasks/${recovered.task_id}.`}
                                </p>
                            </>
                        ) : null}
                        {stream.status === 'error' && !recovered ? (
                            <div role="alert" className="border-warning/40 bg-warning/10 flex flex-col gap-2 rounded-md border p-3 text-sm">
                                <p className="font-medium">Stream connection lost.</p>
                                <p className="text-muted-foreground">
                                    The SSE transport dropped before a terminal frame. Reattaching replays the task’s chunk log from the start — the
                                    panel resets automatically.
                                </p>
                                {postMortem ? (
                                    <p className="text-muted-foreground font-mono text-xs">
                                        {`Task ${postMortem.status}${postMortem.error ? `: ${postMortem.error}` : ''}`}
                                    </p>
                                ) : null}
                                <div>
                                    <Button variant="outline" size="sm" onClick={onReattach}>
                                        <IconPlugConnected aria-hidden />
                                        Reattach stream
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                        {stream.status === 'done' || stream.status === 'closed' ? (
                            <ResultSummary usage={stream.usage} finishReason={stream.finishReason} />
                        ) : null}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function EmptyOutput() {
    return (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-8 text-center">
            <IconSparkles aria-hidden className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">No output yet</p>
            <p className="text-muted-foreground text-sm">
                Write a prompt and press Run — streaming is the default; flip the switch for a single sync response.
            </p>
        </div>
    );
}
