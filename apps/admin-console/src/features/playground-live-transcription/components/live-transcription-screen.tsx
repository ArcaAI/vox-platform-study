'use client';

import { useMemo, useState } from 'react';
import { IconPlayerPlayFilled, IconPlayerStopFilled } from '@tabler/icons-react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { useSession } from '@/shared/auth';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useLiveSttSession, usePlaygroundPipelines } from '../api';
import type { LiveSttStatus } from '../api';
import { BatchTab } from './batch-tab';
import { StreamingTab } from './streaming-tab';

const FOOTER_STATUS: Record<LiveSttStatus, string> = {
    idle: 'Ready — no active session',
    requesting_mic: 'Waiting for microphone permission',
    creating_session: 'Creating streaming session',
    connecting: 'Connecting to the gateway WebSocket',
    streaming: 'Streaming live audio',
    reconnecting: 'Reconnecting with a fresh ticket',
    stopping: 'Stopping the session',
    error: 'Session closed',
};

/** Statuses during which starting another session makes no sense. */
const BUSY_STATUSES: readonly LiveSttStatus[] = ['requesting_mic', 'creating_session', 'connecting', 'streaming', 'reconnecting', 'stopping'];

function ScreenBody() {
    const session = useSession();
    const live = useLiveSttSession();
    const pipelinesQuery = usePlaygroundPipelines();

    const [tabParam, setTabParam] = useQueryState('tab');
    const tab = tabParam === 'batch' ? 'batch' : 'streaming';

    const [pipelineChoice, setPipelineChoice] = useState<string | null>(null);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);

    // Picker options: ENABLED pipelines only; derived default = tenant default.
    const pipelines = useMemo(() => (pipelinesQuery.data ?? []).filter((pipeline) => pipeline.resourceStatus === 'ENABLED'), [pipelinesQuery.data]);
    const defaultPipelineId = (pipelines.find((pipeline) => pipeline.isDefault) ?? pipelines[0])?.id ?? null;
    const pipelineId = pipelineChoice ?? defaultPipelineId;

    const selectedPipeline = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;

    // Sessions bind to the effective (impersonated, when active) tenant;
    // tenant-bound admins use their home tenant. The WS tenant-claim guard
    // fails closed without this value.
    const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.user.tenantId) : null;

    const busy = BUSY_STATUSES.includes(live.status);
    const canStart = !!pipelineId && !!tenantId && !busy;

    function handleStart() {
        if (!pipelineId || !tenantId) {
            toast.error('Pick a pipeline first — sessions need a pipeline and a tenant scope.');
            return;
        }
        void setTabParam(null);
        void live.start({ pipelineId, tenantId });
    }

    function handleStop() {
        void live.stop();
    }

    return (
        <PlaygroundCanvas className="max-w-[1100px]">
            <CanvasHeader
                title="Live Transcription"
                description={'Streaming session \u00b7 runs under your own account'}
                actions={
                    busy ? (
                        <Button variant="outline" onClick={handleStop} disabled={live.status === 'stopping'}>
                            <IconPlayerStopFilled aria-hidden />
                            Stop session
                        </Button>
                    ) : (
                        <Button onClick={handleStart} disabled={!canStart}>
                            <IconPlayerPlayFilled aria-hidden />
                            Start session
                        </Button>
                    )
                }
            />
            <Tabs className="flex min-h-0 flex-1 flex-col gap-4" value={tab} onValueChange={(next) => void setTabParam(next === 'streaming' ? null : next)}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Label htmlFor="pipeline-picker">Pipeline</Label>
                    {pipelinesQuery.isPending ? (
                        <Skeleton className="h-9 w-64" />
                    ) : (
                        <NativeSelect
                            id="pipeline-picker"
                            className="w-64"
                            value={pipelineId ?? ''}
                            onChange={(event) => setPipelineChoice(event.target.value || null)}
                            disabled={busy || pipelines.length === 0}
                        >
                            {pipelines.length === 0 ? <NativeSelectOption value="">No pipelines available</NativeSelectOption> : null}
                            {pipelines.map((pipeline) => (
                                <NativeSelectOption key={pipeline.id} value={pipeline.id}>
                                    {pipeline.name}
                                    {pipeline.isDefault ? ' \u00b7 default' : ''}
                                </NativeSelectOption>
                            ))}
                        </NativeSelect>
                    )}
                    <span className="text-muted-foreground text-xs">{FOOTER_STATUS[live.status]}</span>
                    {live.session ? (
                        <span className="text-muted-foreground ml-auto font-mono text-xs" title={live.session.sessionId}>
                            session {live.session.sessionId}
                        </span>
                    ) : null}
                </div>
                <TabsList variant="line">
                    <TabsTrigger value="streaming">Streaming session</TabsTrigger>
                    <TabsTrigger value="batch">Batch upload</TabsTrigger>
                </TabsList>
                <TabsContent value="streaming">
                    <StreamingTab live={live} pipelineName={selectedPipeline?.name ?? null} canStart={canStart} onStart={handleStart} />
                </TabsContent>
                <TabsContent value="batch">
                    <BatchTab pipelineId={pipelineId} activeJobId={activeJobId} onActiveJobChange={setActiveJobId} />
                </TabsContent>
            </Tabs>
        </PlaygroundCanvas>
    );
}

/**
 * Frame 51 — Live transcription playground (matrix row 35). Tenant context
 * is required: streaming sessions bind `user.tenantId`, so an elevated
 * session without a working tenant gets the NoTenant gate.
 */
export function LiveTranscriptionScreen() {
    return (
        <WorkingTenantGate
            title="Live Transcription"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    POST /audio/transcription-jobs/stream/session
                </span>
            }
            description="Live streaming sessions bind to a tenant. Pick a working tenant from the switcher in the top bar to start transcribing."
        >
            <ScreenBody />
        </WorkingTenantGate>
    );
}
