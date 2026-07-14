'use client';

/**
 * Frame 50 — Consultation Demo (TASK-432, matrix row 34). An `@arcaai/vox`
 * SDK showcase: open a consultation, capture mic audio through the
 * noise-filter/VAD/streaming-STT pipeline, watch the live transcript and the
 * SSE live summary, then generate the clinical note (sync or async job) and
 * hand off to the Documentation Review phase (frame 50.1).
 *
 * Transport split (TASK-431): SDK/REST calls go through the BFF proxy
 * (`/api/hope`, auth injected server-side — no token in the browser); the
 * STT WebSocket and all SSE streams connect DIRECTLY to the gateway
 * (`publicEnv.apiHost`) — WS via the SDK `wsUrl` config, SSE via single-use
 * tickets minted through `/api/auth/stream-ticket`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
    IconBolt,
    IconClipboardCheck,
    IconExclamationCircle,
    IconFileText,
    IconMicrophone,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlus,
    IconX,
} from '@tabler/icons-react';
import { AgenticProvider, useArca, useArcaSession, useStoreApi } from '@arcaai/vox';
import { toast } from 'sonner';
import { AudioMeter } from '@arcaai/ui/components/custom/audio-meter';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { publicEnv } from '@/config/public-env';
import { useSession } from '@/shared/auth';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import type { StreamStatus } from '@/shared/streams';
import {
    consultationJobStateLabel,
    useAudioPipelines,
    useCancelConsultationJob,
    useGenerateSummary,
    useGenerateSummaryAsync,
    useLiveSummaryStream,
    useStartRecording,
    useStopRecording,
    useSummaryJobProgress,
    type PlaygroundConsultation,
    type UseSummaryJobProgressResult,
} from '../api';
import { DocumentationReviewPanel } from './documentation-review-panel';

// ─── helpers ───

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

const CONSULTATION_STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
    OPEN: { label: 'Open', role: 'success' },
    RECORDING: { label: 'Recording', role: 'destructive' },
    PENDING_REVIEW: { label: 'Pending review', role: 'warning' },
    COMPLETED: { label: 'Completed', role: 'success' },
    CLOSED: { label: 'Closed', role: 'neutral' },
};

function consultationStatusMeta(status: string): { label: string; role: StatusColorRole } {
    return CONSULTATION_STATUS_META[status.toUpperCase()] ?? { label: status, role: 'neutral' };
}

const LIVE_STREAM_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
    idle: { label: 'Idle', role: 'neutral' },
    connecting: { label: 'Connecting', role: 'info' },
    open: { label: 'Live', role: 'success' },
    error: { label: 'Offline', role: 'destructive' },
    closed: { label: 'Ended', role: 'neutral' },
};

function jobStateRole(status: string | null | undefined): StatusColorRole {
    switch (status?.toUpperCase()) {
        case 'COMPLETED':
            return 'success';
        case 'FAILED':
            return 'destructive';
        case 'CANCELLED':
            return 'neutral';
        case 'RUNNING':
        case 'PROCESSING':
            return 'info';
        default:
            return 'neutral';
    }
}

function formatElapsed(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatClock(seconds: number): string {
    return formatElapsed(Math.max(0, Math.floor(seconds)));
}

/**
 * The SDK's streaming sessionId (needed by `recording/start` so the live
 * summariser can attach to the STT session) lives on the transcription
 * pipeline's transport, reached imperatively through the provider store.
 * The chain is version-tolerant (`unknown`-typed navigation) and bounded —
 * when the id can't be read the body field is simply omitted; the
 * LiveDocumentationService then falls back to context-item ingestion.
 */
function readStreamingSessionId(state: unknown): string | null {
    const pipeline = (
        state as { pluginManager?: { getTranscriptionPipeline?: () => unknown } | null }
    ).pluginManager?.getTranscriptionPipeline?.();
    const transport = (pipeline as { getConfig?: () => { stt?: { streamingTransport?: unknown } } } | null)?.getConfig?.()?.stt
        ?.streamingTransport;
    const sessionId = (transport as { sessionManager?: { getSessionId?: () => string | null } } | undefined)?.sessionManager?.getSessionId?.();
    return sessionId ?? null;
}

async function resolveStreamingSessionId(storeApi: { getState: () => unknown }, attempts = 8, delayMs = 250): Promise<string | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const sessionId = readStreamingSessionId(storeApi.getState());
        if (sessionId) return sessionId;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
}

// ─── screen shell ───

/** Route skeleton — mirrored by the route's loading.tsx; the centered canvas flow. */
export function ConsultationDemoSkeleton() {
    return (
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-7 w-64" />
                    <Skeleton className="h-4 w-96 max-w-full" />
                </div>
                <Skeleton className="h-9 w-40" />
            </div>
            <Skeleton className="h-9 w-72 max-w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-56 w-full" />
        </div>
    );
}

/** Frame 50 + 50.1 — tenant-gated `@arcaai/vox` consultation demo. */
export function ConsultationDemoScreen() {
    return (
        <WorkingTenantGate
            title="Consultation Demo"
            meta={<span>@arcaai/vox — capture, live transcription, live summary and documentation review</span>}
            description="The demo opens consultations and stores drafts in the working tenant. Pick one from the switcher in the top bar."
        >
            <SdkBoundary />
        </WorkingTenantGate>
    );
}

/**
 * Structural view of the SDK's `AgenticConfig` — `@arcaai/vox` ships with
 * `dts: false` (see packages/agentic-sdk-v2/tsup.config.ts), so the config
 * this screen feeds `AgenticProvider` is typed locally against the subset
 * it actually sets. Validated at runtime by the SDK's own schema.
 */
interface VoxProviderConfig {
    api: { baseUrl: string; wsUrl?: string; tenantId?: string };
    audio?: {
        noiseFilter?: { enabled: boolean };
        vad?: { enabled: boolean };
        stt?: { enabled: boolean; provider: string };
    };
    autoWireTokenRefresh?: boolean;
}

const emptySubscribe = () => () => {};

/** False during SSR + the hydration render, true afterwards. */
function useHydrated(): boolean {
    return useSyncExternalStore(
        emptySubscribe,
        () => true,
        () => false,
    );
}

/**
 * Client-only SDK mount: the provider config needs `window.location.origin`,
 * so the interactive area renders after hydration (the skeleton covers SSR
 * and the first client frame).
 */
function SdkBoundary() {
    const session = useSession();
    const mounted = useHydrated();

    const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.user.tenantId) || undefined : undefined;

    const config = useMemo<VoxProviderConfig | null>(() => {
        if (!mounted) return null;
        return {
            // REST → BFF proxy (auth injected server-side; SDK carries no token).
            // WS → gateway directly (AgenticClient.getWsUrl, TASK-431).
            api: {
                baseUrl: `${window.location.origin}/api/hope`,
                wsUrl: publicEnv.apiHost,
                tenantId,
            },
            audio: {
                noiseFilter: { enabled: true },
                vad: { enabled: true },
                // Backend streaming STT; the pipeline is picked per capture
                // via audio.start({ pipelineId }).
                stt: { enabled: true, provider: 'backend' },
            },
            autoWireTokenRefresh: false,
        };
    }, [mounted, tenantId]);

    if (!config) return <ConsultationDemoSkeleton />;

    return (
        <AgenticProvider config={config}>
            <DemoScreen />
        </AgenticProvider>
    );
}

// ─── the demo screen (inside the provider) ───

function DemoScreen() {
    const { session: sdkSession, audio } = useArca();
    const arcaSession = useArcaSession();
    const storeApi = useStoreApi();

    const [tab, setTab] = useState('demo');
    const [consultation, setConsultation] = useState<PlaygroundConsultation | null>(null);
    const [patientId, setPatientId] = useState('');
    const [patientIdError, setPatientIdError] = useState<string | null>(null);
    const [pipelineChoice, setPipelineChoice] = useState('');
    const [liveSummaryArmed, setLiveSummaryArmed] = useState(false);
    const [jobId, setJobId] = useState<string | null>(null);
    const [captureBusy, setCaptureBusy] = useState(false);
    const [sessionBusy, setSessionBusy] = useState(false);
    const [openPending, setOpenPending] = useState(false);
    const patientInputRef = useRef<HTMLInputElement | null>(null);

    /** Header CTA (frame 50): the open form is inline, so "open" = move focus to it. */
    function focusPatientInput() {
        patientInputRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        patientInputRef.current?.focus();
    }

    const pipelines = useAudioPipelines();
    // Derived selection: the tenant default applies until the user picks one.
    const defaultPipelineId = pipelines.data ? ((pipelines.data.find((pipeline) => pipeline.isDefault) ?? pipelines.data[0])?.id ?? '') : '';
    const pipelineId = pipelineChoice || defaultPipelineId;

    const recordingStart = useStartRecording();
    const recordingStop = useStopRecording();
    const summarySync = useGenerateSummary();
    const summaryAsync = useGenerateSummaryAsync();
    const cancelJob = useCancelConsultationJob();

    const jobProgress = useSummaryJobProgress(jobId, {
        onTerminal: useCallback((job) => {
            if (job.status.toUpperCase() === 'COMPLETED') {
                toast.success('Summary job completed — the draft is ready for review');
                return;
            }
            const detail = job.error ?? job.errorMessage;
            toast.error(`Summary job ${consultationJobStateLabel(job.status).toLowerCase()}${detail ? `: ${detail}` : ''}`);
        }, []),
    });

    const liveSummary = useLiveSummaryStream(consultation?.id ?? null, liveSummaryArmed);

    // ── flows ──

    async function handleOpenSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const trimmed = patientId.trim();
        if (!trimmed) {
            setPatientIdError('Patient ID is required.');
            return;
        }
        setPatientIdError(null);
        setOpenPending(true);
        try {
            const opened = await sdkSession.open({ patientId: trimmed });
            setConsultation({
                id: opened.id,
                patientId: opened.patientId,
                status: String(opened.status ?? 'OPEN'),
                createdAt: typeof opened.createdAt === 'string' ? opened.createdAt : new Date().toISOString(),
            });
            setJobId(null);
            setLiveSummaryArmed(false);
            toast.success('Consultation opened');
        } catch (error) {
            toast.error(errorMessage(error, 'Could not open the consultation'));
        } finally {
            setOpenPending(false);
        }
    }

    async function handleStartRecording() {
        if (!consultation) return;
        setCaptureBusy(true);
        try {
            await audio.start({ pipelineId: pipelineId || undefined });
            const sessionId = (await resolveStreamingSessionId(storeApi)) ?? undefined;
            const state = await recordingStart.mutateAsync({ consultationId: consultation.id, sessionId });
            setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
            setLiveSummaryArmed(true);
            toast.success('Recording started');
        } catch (error) {
            toast.error(errorMessage(error, 'Could not start recording'));
            void audio.stop().catch(() => undefined);
        } finally {
            setCaptureBusy(false);
        }
    }

    async function handleStopRecording() {
        if (!consultation) return;
        setCaptureBusy(true);
        try {
            await audio.stop();
            const state = await recordingStop.mutateAsync({ consultationId: consultation.id });
            setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
            toast.success('Recording stopped — final snapshot persisted');
        } catch (error) {
            toast.error(errorMessage(error, 'Could not stop recording'));
        } finally {
            setCaptureBusy(false);
        }
    }

    async function handleCloseConsultation() {
        setSessionBusy(true);
        try {
            const updated = await arcaSession.close();
            setConsultation((previous) => (previous ? { ...previous, status: String(updated?.status ?? 'CLOSED') } : previous));
            toast.success('Consultation closed');
        } catch (error) {
            toast.error(errorMessage(error, 'Could not close the consultation'));
        } finally {
            setSessionBusy(false);
        }
    }

    async function handleReopenConsultation() {
        setSessionBusy(true);
        try {
            const updated = await arcaSession.reopen();
            setConsultation((previous) => (previous ? { ...previous, status: String(updated?.status ?? 'OPEN') } : previous));
            toast.success('Consultation reopened');
        } catch (error) {
            toast.error(errorMessage(error, 'Could not reopen the consultation'));
        } finally {
            setSessionBusy(false);
        }
    }

    function handleGenerateSync() {
        if (!consultation) return;
        summarySync.mutate(
            { consultationId: consultation.id },
            {
                onSuccess: () => toast.success('Summary generated — open Documentation review to inspect it'),
                onError: (error) => toast.error(errorMessage(error, 'Summary generation failed')),
            },
        );
    }

    function handleGenerateAsync() {
        if (!consultation) return;
        summaryAsync.mutate(
            { consultationId: consultation.id },
            {
                onSuccess: (job) => setJobId(job.jobId),
                onError: (error) => toast.error(errorMessage(error, 'Could not queue the summary job')),
            },
        );
    }

    function handleCancelJob() {
        if (!jobId) return;
        cancelJob.mutate(jobId, {
            onSuccess: () => toast.success('Job cancel requested'),
            onError: (error) => toast.error(errorMessage(error, 'Could not cancel the job')),
        });
    }

    const isClosed = consultation?.status.toUpperCase() === 'CLOSED';
    const isRecording = consultation?.status.toUpperCase() === 'RECORDING';
    const canRecord = !!consultation && !isClosed;
    const canDocument = !!consultation;
    const statusMeta = consultation ? consultationStatusMeta(consultation.status) : null;

    return (
        <PlaygroundCanvas>
            <CanvasHeader
                title="Consultation Demo"
                description="@arcaai/vox — capture, live transcription, live summary and documentation review"
                actions={
                    tab === 'demo' ? (
                        <Button onClick={focusPatientInput}>
                            <IconPlus aria-hidden />
                            Open consultation
                        </Button>
                    ) : undefined
                }
            />
            {consultation && statusMeta ? (
                <div className="bg-card flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Consultation:</span>
                    <code className="font-mono text-xs">{consultation.id}</code>
                    <span className="text-muted-foreground text-xs">(demo)</span>
                    <code className="text-muted-foreground font-mono text-xs">{consultation.patientId}</code>
                    {isRecording ? (
                        <span className="text-destructive flex items-center gap-1.5 text-xs font-semibold">
                            <span aria-hidden className="bg-destructive size-2 animate-pulse rounded-full" />
                            RECORDING
                        </span>
                    ) : (
                        <StatusBadge label={statusMeta.label} colorRole={statusMeta.role} />
                    )}
                    <span className="text-muted-foreground text-xs">Opened {formatDateTime(consultation.createdAt)}</span>
                    <span aria-hidden className="text-muted-foreground ms-auto font-mono text-xs">
                        POST /consultations/open {'·'} recording/start|stop
                    </span>
                </div>
            ) : null}
            <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-4">
                <TabsList variant="line">
                    <TabsTrigger value="demo">Consultation demo</TabsTrigger>
                    <TabsTrigger value="review">Documentation review</TabsTrigger>
                </TabsList>
                {/* End-user preview (TASK-442 §4): one centered top-to-bottom flow —
                    setup → capture → live transcript → live summary → document — instead
                    of the old 3-column console grid. */}
                <TabsContent value="demo" className="flex flex-col gap-4">
                    <Card>
                                <CardHeader>
                                    <CardTitle>Demo setup</CardTitle>
                                    <CardDescription>Open (or resume) today&apos;s consultation for a patient, then capture.</CardDescription>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    <form noValidate onSubmit={handleOpenSubmit} className="flex flex-col gap-4">
                                        <div className="flex flex-col gap-2">
                                            <Label htmlFor="pc-patient-id">
                                                Patient ID{' '}
                                                <span aria-hidden className="text-destructive">
                                                    *
                                                </span>
                                            </Label>
                                            <Input
                                                id="pc-patient-id"
                                                ref={patientInputRef}
                                                value={patientId}
                                                onChange={(event) => setPatientId(event.target.value)}
                                                placeholder="e.g. P-448"
                                                autoComplete="off"
                                                aria-required="true"
                                                aria-invalid={patientIdError ? true : undefined}
                                                aria-describedby={patientIdError ? 'pc-patient-id-error' : undefined}
                                            />
                                            {patientIdError ? (
                                                <p id="pc-patient-id-error" className="text-destructive text-sm">
                                                    {patientIdError}
                                                </p>
                                            ) : null}
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <Label htmlFor="pc-pipeline">Transcription pipeline</Label>
                                            {pipelines.isPending ? (
                                                <Skeleton className="h-9 w-full" />
                                            ) : pipelines.isError ? (
                                                <ErrorState
                                                    title="Couldn't load pipelines"
                                                    error={pipelines.error}
                                                    onRetry={() => void pipelines.refetch()}
                                                />
                                            ) : (
                                                <NativeSelect
                                                    id="pc-pipeline"
                                                    value={pipelineId}
                                                    onChange={(event) => setPipelineChoice(event.target.value)}
                                                >
                                                    {pipelines.data.map((pipeline) => (
                                                        <NativeSelectOption key={pipeline.id} value={pipeline.id}>
                                                            {pipeline.name}
                                                            {pipeline.isDefault ? ' (default)' : ''}
                                                        </NativeSelectOption>
                                                    ))}
                                                </NativeSelect>
                                            )}
                                        </div>
                                        <div>
                                            <Button type="submit" disabled={openPending}>
                                                {openPending ? <Spinner /> : <IconPlayerPlay aria-hidden />}
                                                Open consultation
                                            </Button>
                                        </div>
                                    </form>
                                    {consultation ? (
                                        <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-sm">
                                            <span className="text-muted-foreground">
                                                {isClosed ? 'Consultation closed.' : 'Consultation in progress — status in the strip above.'}
                                            </span>
                                            <div className="ms-auto">
                                                {isClosed ? (
                                                    <Button variant="outline" size="sm" onClick={handleReopenConsultation} disabled={sessionBusy}>
                                                        {sessionBusy ? <Spinner /> : null}
                                                        Reopen consultation
                                                    </Button>
                                                ) : (
                                                    <Button variant="outline" size="sm" onClick={handleCloseConsultation} disabled={sessionBusy}>
                                                        {sessionBusy ? <Spinner /> : null}
                                                        Close consultation
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>

                            <CapturePane
                                audio={audio}
                                canRecord={canRecord}
                                busy={captureBusy}
                                onStart={handleStartRecording}
                                onStop={handleStopRecording}
                            />

                    <TranscriptPane audio={audio} />

                    <LiveSummaryPane armed={liveSummaryArmed} stream={liveSummary} />

                                <Card>
                                    <CardHeader>
                                        <CardTitle>Document</CardTitle>
                                        <CardDescription>
                                            Generate the clinical note from the captured context, then review and sign off.
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="flex flex-col gap-4">
                                        <div className="flex flex-wrap gap-2">
                                            <Button variant="outline" disabled={!canDocument || summarySync.isPending} onClick={handleGenerateSync}>
                                                {summarySync.isPending ? <Spinner /> : <IconFileText aria-hidden />}
                                                Generate summary
                                            </Button>
                                            <Button
                                                variant="outline"
                                                disabled={!canDocument || summaryAsync.isPending || (!!jobId && !jobProgress.isTerminal)}
                                                onClick={handleGenerateAsync}
                                            >
                                                {summaryAsync.isPending ? <Spinner /> : <IconBolt aria-hidden />}
                                                Generate async job
                                            </Button>
                                            <Button variant="secondary" disabled={!canDocument} onClick={() => setTab('review')}>
                                                <IconClipboardCheck aria-hidden />
                                                Review &amp; sign-off
                                            </Button>
                                        </div>
                                        {jobId ? (
                                            <JobStrip
                                                jobId={jobId}
                                                progress={jobProgress}
                                                cancelPending={cancelJob.isPending}
                                                onCancel={handleCancelJob}
                                            />
                                        ) : null}
                                    </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="review">
                    {consultation ? (
                        <DocumentationReviewPanel consultationId={consultation.id} onBackToDemo={() => setTab('demo')} />
                    ) : (
                        <EmptyState
                            icon={IconClipboardCheck}
                            title="Nothing to review yet"
                            description="Open a consultation on the demo tab and generate a draft first."
                            action={
                                <Button variant="outline" onClick={() => setTab('demo')}>
                                    Back to consultation demo
                                </Button>
                            }
                        />
                    )}
                </TabsContent>
            </Tabs>
        </PlaygroundCanvas>
    );
}

// ─── capture pane ───

interface AudioSurface {
    isCapturing: boolean;
    isMuted: boolean;
    level: number;
    isSpeaking: boolean;
    currentTranscript: string;
    transcriptSegments: Array<{ text: string; startTime: number; endTime: number; isFinal: boolean; speakerLabel?: string }>;
    plugins: { noiseFilter: { isActive: boolean }; vad: { isActive: boolean } };
    error: Error | null;
}

function captureErrorMessage(error: Error): string {
    if (error.name === 'NotAllowedError') {
        return 'Microphone access was denied — allow microphone access for this site in your browser settings, then try again.';
    }
    return error.message || 'Audio capture failed.';
}

function CapturePane({
    audio,
    canRecord,
    busy,
    onStart,
    onStop,
}: {
    audio: AudioSurface;
    canRecord: boolean;
    busy: boolean;
    onStart: () => void;
    onStop: () => void;
}) {
    // Elapsed time is a tick counter driven by the interval below; the
    // render-time adjustment resets it (and latches "mic was granted")
    // exactly when a capture starts — no setState inside the effect body.
    const [everCaptured, setEverCaptured] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [prevCapturing, setPrevCapturing] = useState(false);
    if (audio.isCapturing !== prevCapturing) {
        setPrevCapturing(audio.isCapturing);
        if (audio.isCapturing) {
            setElapsed(0);
            setEverCaptured(true);
        }
    }

    useEffect(() => {
        if (!audio.isCapturing) return;
        const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1_000);
        return () => clearInterval(timer);
    }, [audio.isCapturing]);

    const micDenied = audio.error?.name === 'NotAllowedError';
    const micPermissionLabel = micDenied ? 'denied' : audio.isCapturing || everCaptured ? 'granted' : 'prompt on first Start';

    return (
        <Card>
            <CardHeader>
                <CardTitle>Capture</CardTitle>
                <CardDescription>Microphone &rarr; noise filter &rarr; VAD &rarr; streaming STT</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    {audio.isCapturing ? (
                        <Badge variant="destructive" className="gap-1.5 tabular-nums">
                            <span aria-hidden className="size-2 animate-pulse rounded-full bg-current" />
                            REC {formatElapsed(elapsed)}
                        </Badge>
                    ) : null}
                    <Badge variant="outline" className={micDenied ? 'border-destructive/40 text-destructive' : undefined}>
                        Mic permission: {micPermissionLabel}
                    </Badge>
                    <Badge variant="outline">VAD {audio.plugins.vad.isActive ? 'on' : 'off'}</Badge>
                    <Badge variant="outline">Noise filter {audio.plugins.noiseFilter.isActive ? 'on' : 'off'}</Badge>
                </div>

                <AudioMeter level={audio.level} isCapturing={audio.isCapturing} isSpeaking={audio.isSpeaking} isMuted={audio.isMuted} />

                {audio.error ? (
                    <div
                        role="alert"
                        className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                        <IconExclamationCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span>{captureErrorMessage(audio.error)}</span>
                    </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                    {audio.isCapturing ? (
                        <Button variant="destructive" onClick={onStop} disabled={busy}>
                            {busy ? <Spinner /> : <IconPlayerStop aria-hidden />}
                            Stop recording
                        </Button>
                    ) : (
                        <Button onClick={onStart} disabled={!canRecord || busy}>
                            {busy ? <Spinner /> : <IconMicrophone aria-hidden />}
                            Start recording
                        </Button>
                    )}
                    {!everCaptured && !audio.isCapturing ? (
                        <p className="text-muted-foreground text-xs">Your browser asks for the microphone on the first start.</p>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}

// ─── transcript pane ───

function TranscriptPane({ audio }: { audio: AudioSurface }) {
    const listRef = useRef<HTMLUListElement | null>(null);

    // Auto-scroll: keep the newest row in view as segments stream in.
    useEffect(() => {
        const node = listRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [audio.transcriptSegments, audio.currentTranscript]);

    const isEmpty = audio.transcriptSegments.length === 0 && !audio.currentTranscript;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Live transcript</CardTitle>
                <CardDescription>Final segments settle in place; the partial row updates as you speak.</CardDescription>
            </CardHeader>
            <CardContent>
                {isEmpty ? (
                    <p className="text-muted-foreground text-sm">No speech captured yet.</p>
                ) : (
                    <ul ref={listRef} aria-label="Transcript" className="flex max-h-72 flex-col gap-2 overflow-y-auto pe-1">
                        {audio.transcriptSegments.map((segment, index) => (
                            <li key={`${segment.startTime}-${index}`} className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
                                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                                    {segment.speakerLabel ? <span className="text-foreground font-medium">{segment.speakerLabel}</span> : null}
                                    <span className="tabular-nums">{formatClock(segment.startTime)}</span>
                                </div>
                                <p className="text-sm">{segment.text}</p>
                            </li>
                        ))}
                        {audio.currentTranscript ? (
                            <li data-partial="true" className="border-primary/40 bg-primary/5 rounded-md border border-dashed px-3 py-2">
                                <p className="text-muted-foreground text-sm italic">
                                    {audio.currentTranscript}
                                    <span aria-hidden className="text-primary ms-0.5 animate-pulse">
                                        {'\u258B'}
                                    </span>
                                </p>
                            </li>
                        ) : null}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

// ─── live summary pane ───

function LiveSummaryPane({ armed, stream }: { armed: boolean; stream: ReturnType<typeof useLiveSummaryStream> }) {
    const snapshot = stream.snapshot;
    const badge = snapshot?.closed ? LIVE_STREAM_META.closed : LIVE_STREAM_META[armed ? stream.status : 'idle'];

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                    <CardTitle>Live summary</CardTitle>
                    <CardDescription>Running SOAP snapshot over SSE while recording.</CardDescription>
                </div>
                <StatusBadge label={badge.label} colorRole={badge.role} />
            </CardHeader>
            <CardContent>
                {!armed ? (
                    <p className="text-muted-foreground text-sm">Start recording to stream the running summary.</p>
                ) : !snapshot ? (
                    <p className="text-muted-foreground text-sm">Waiting for the first live snapshot&hellip;</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {snapshot.sections.map((section) => (
                            <section key={section.title} className="flex flex-col gap-1">
                                <h3 className="text-sm font-medium">{section.title}</h3>
                                <p className="text-muted-foreground text-sm whitespace-pre-wrap">{section.content}</p>
                            </section>
                        ))}
                        {snapshot.entities.length > 0 ? (
                            <div aria-label="Detected entities" className="flex flex-wrap gap-1.5">
                                {snapshot.entities.map((entity) => (
                                    <Badge key={`${entity.type}-${entity.text}`} variant="secondary">
                                        {entity.text}
                                    </Badge>
                                ))}
                            </div>
                        ) : null}
                        <p className="text-muted-foreground text-xs">Updated {formatDateTime(snapshot.updatedAt)}</p>
                    </div>
                )}
                {armed && stream.status === 'error' ? (
                    <div className="mt-3 flex items-center gap-2">
                        <p className="text-destructive text-xs">{stream.error ?? 'Live summary stream unavailable.'}</p>
                        <Button variant="outline" size="sm" onClick={stream.reopen}>
                            Reconnect
                        </Button>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
}

// ─── async job strip ───

function JobStrip({
    jobId,
    progress,
    cancelPending,
    onCancel,
}: {
    jobId: string;
    progress: UseSummaryJobProgressResult;
    cancelPending: boolean;
    onCancel: () => void;
}) {
    const job = progress.job;
    const percent = Math.max(0, Math.min(100, job?.progress ?? 0));
    const detail = job?.error ?? job?.errorMessage;

    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Job</span>
                <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{jobId}</code>
                <StatusBadge label={consultationJobStateLabel(job?.status ?? 'PENDING')} colorRole={jobStateRole(job?.status)} />
                <span className="tabular-nums">{percent}%</span>
                {job?.currentStep ? <span className="text-muted-foreground truncate text-xs">{job.currentStep}</span> : null}
                {!progress.isTerminal ? (
                    <Button variant="ghost" size="sm" className="ms-auto" onClick={onCancel} disabled={cancelPending}>
                        {cancelPending ? <Spinner /> : <IconX aria-hidden />}
                        Cancel job
                    </Button>
                ) : null}
            </div>
            <Progress value={percent} aria-label="Job progress" />
            {progress.streamStatus === 'error' && !progress.isTerminal ? (
                <p className="text-muted-foreground text-xs">Stream unavailable — falling back to a 2s status poll.</p>
            ) : null}
            {detail ? <p className="text-destructive text-xs">{detail}</p> : null}
        </div>
    );
}
