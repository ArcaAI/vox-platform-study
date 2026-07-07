'use client';

import type { FormEvent } from 'react';
import { IconBolt } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import type { StreamStatus } from '@/shared/streams';
import type { DnaJobStatus, UseDnaJobProgressResult } from '../api';

const JOB_STATE_LABELS: Record<DnaJobStatus['status'], string> = {
    queued: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
};

/**
 * Transport badge for the progress strip: Live while the SSE stream (the
 * primary transport) is open, Polling once it errors and the documented 2s
 * fallback poll takes over (see useDnaJobProgress), Done/Failed at terminal.
 * Never color-only: the label rides along and the percent is printed next to
 * the bar.
 */
function jobBadgeMeta(job: DnaJobStatus | null, streamStatus: StreamStatus, isTerminal: boolean): { label: string; role: StatusColorRole } {
    if (isTerminal) {
        return job?.status === 'completed' ? { label: 'Done', role: 'success' } : { label: 'Failed', role: 'destructive' };
    }
    if (streamStatus === 'open') return { label: 'Live', role: 'primary' };
    if (streamStatus === 'connecting') return { label: 'Connecting', role: 'info' };
    if (streamStatus === 'error') return { label: 'Polling', role: 'warning' };
    return { label: 'Waiting', role: 'neutral' };
}

/** Inline job progress (SSE/poll driven) shown while a generation runs. */
function JobProgressStrip({ jobId, progress }: { jobId: string; progress: UseDnaJobProgressResult }) {
    const { job, streamStatus, isTerminal } = progress;
    const percent = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
    const meta = jobBadgeMeta(job, streamStatus, isTerminal);
    const stateLabel = job ? JOB_STATE_LABELS[job.status] : 'Queued';

    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
                <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{jobId}</span>
            </div>
            <Progress value={percent} aria-label={`DNA generation progress: ${stateLabel}, ${percent}%`} />
            <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
                {stateLabel} {'\u00b7'} {percent}%
                {job?.status === 'failed' && job.error ? <span className="text-destructive"> {'\u00b7'} {job.error}</span> : null}
            </p>
        </div>
    );
}

/**
 * Frame 53 generate pane — POST /generate queues a job for the CALLER, then
 * the ticket-authenticated SSE stream (scope `dna_job:<jobId>`) drives the
 * progress strip with the documented 2s poll fallback. The action is gated
 * behind doctor context (403 assertActingAsDoctor — the panel explains it).
 */
export function GeneratePane({
    samplesText,
    onSamplesTextChange,
    onGenerate,
    isPending,
    gated,
    activeJobId,
    progress,
}: {
    samplesText: string;
    onSamplesTextChange: (value: string) => void;
    onGenerate: () => void;
    isPending: boolean;
    gated: boolean;
    activeJobId: string | null;
    progress: UseDnaJobProgressResult;
}) {
    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        onGenerate();
    }

    return (
        <Card className="gap-4">
            <CardHeader>
                <h2 className="text-sm leading-none font-semibold">Generate</h2>
                <CardAction>
                    <span aria-hidden className="text-muted-foreground font-mono text-xs">
                        POST /generate
                    </span>
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="playground-dna-text-samples">Text samples</Label>
                        <Textarea
                            id="playground-dna-text-samples"
                            value={samplesText}
                            onChange={(event) => onSamplesTextChange(event.target.value)}
                            placeholder={'Paste clinical notes to analyze \u2014 one sample per blank-line-separated block.'}
                            rows={6}
                            className="resize-none text-sm"
                        />
                        <p className="text-muted-foreground text-xs">
                            Leave empty to analyze your recent context items instead of pasted samples.
                        </p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        {gated ? <span className="text-muted-foreground text-xs">Requires acting as a doctor</span> : null}
                        <Button type="submit" size="sm" disabled={gated || isPending}>
                            {isPending ? <Spinner /> : <IconBolt aria-hidden />}
                            Generate
                        </Button>
                    </div>
                </form>
                {activeJobId ? <JobProgressStrip jobId={activeJobId} progress={progress} /> : null}
                <p aria-hidden className="text-muted-foreground font-mono text-xs">
                    SSE: GET /jobs/:jobId/stream
                </p>
            </CardContent>
        </Card>
    );
}
