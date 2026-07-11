'use client';

import { useEffect, useRef, useState } from 'react';
import { IconAlertTriangle, IconBroadcast, IconMicrophone, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh } from '@tabler/icons-react';
import { AudioMeter } from '@arcaai/ui/components/custom/audio-meter';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';
import type { LiveSttStatus, UseLiveSttSessionResult } from '../api';

const STATUS_META: Record<LiveSttStatus, { label: string; role: StatusColorRole }> = {
    idle: { label: 'Idle', role: 'neutral' },
    requesting_mic: { label: 'Mic prompt', role: 'info' },
    creating_session: { label: 'Creating session', role: 'info' },
    connecting: { label: 'Connecting', role: 'info' },
    streaming: { label: 'Streaming', role: 'success' },
    reconnecting: { label: 'Reconnecting', role: 'warning' },
    stopping: { label: 'Stopping', role: 'neutral' },
    error: { label: 'Closed', role: 'destructive' },
};

function formatClock(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Frame 51 designed error state — 429 at maxConcurrentSessions. */
function QuotaPanel({ onRetry }: { onRetry: () => void }) {
    return (
        <Card role="alert" className="border-destructive/40 flex flex-col items-center gap-3 p-10 text-center">
            <IconAlertTriangle aria-hidden className="text-destructive size-8" />
            <div className="flex flex-col gap-1">
                <p className="text-destructive font-medium">Session quota reached</p>
                <p className="text-muted-foreground text-sm">
                    The gateway returned 429 — this tenant is at maxConcurrentSessions (entitlements). Stop another live session or retry in a
                    moment.
                </p>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry}>
                <IconRefresh aria-hidden />
                Retry
            </Button>
        </Card>
    );
}

/** Generic close panel — all WS handshake failures collapse to 4401 (no cause leak). */
function SessionErrorPanel({ message, onRestart }: { message: string; onRestart: () => void }) {
    return (
        <Card role="alert" className="border-destructive/40 flex flex-col items-center gap-3 p-10 text-center">
            <IconAlertTriangle aria-hidden className="text-destructive size-8" />
            <div className="flex flex-col gap-1">
                <p className="text-destructive font-medium">Session error</p>
                <p className="text-muted-foreground text-sm">{message}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onRestart}>
                <IconPlayerPlayFilled aria-hidden />
                Start new session
            </Button>
        </Card>
    );
}

/**
 * C6-01 — the STT WS client silently drops outbound audio above its 1 MiB
 * bufferedAmount watermark. This announced banner makes that clinical data loss
 * visible. It is driven by the session-sticky `audioLostThisSession` latch, so
 * the copy is past/stative (the loss is permanent even after the connection
 * recovers). Meaning is carried by icon + text (never color alone); the stable
 * message is announced once via the polite live region, and the per-connection
 * frame count is kept out of the announcement (aria-hidden) so its churn does
 * not spam assistive tech — and it is shown only while the current connection
 * is actively dropping.
 */
export function DegradedBanner({ droppedFrameCount }: { droppedFrameCount: number }) {
    return (
        <div
            role="status"
            aria-live="polite"
            className="border-warning/40 bg-warning/10 text-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
            <IconAlertTriangle aria-hidden className="text-warning-strong mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
                <p>
                    <span className="font-medium">Audio was dropped</span>
                    {' — '}this session{'’'}s transcript is incomplete.
                </p>
                {droppedFrameCount > 0 ? (
                    <p className="text-foreground/90 text-xs tabular-nums" aria-hidden>
                        {droppedFrameCount} audio frame{droppedFrameCount === 1 ? '' : 's'} dropped on the current connection.
                    </p>
                ) : null}
            </div>
        </div>
    );
}

function SessionControlsCard({
    live,
    pipelineName,
    now,
    onStop,
}: {
    live: UseLiveSttSessionResult;
    pipelineName: string | null;
    now: number;
    onStop: () => void;
}) {
    const meta = STATUS_META[live.status];
    const busy = live.status === 'stopping';
    const ticketRemainingSec = live.session ? Math.max(0, Math.ceil((live.session.ticketExpiresAt - now) / 1000)) : null;

    return (
        <Card className="gap-4">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm leading-none font-semibold">Session controls</h2>
                <div className="flex items-center gap-2">
                    <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
                    {live.session && live.status === 'streaming' ? (
                        <span className="text-muted-foreground text-xs tabular-nums">{formatElapsed(now - live.session.startedAt)}</span>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground text-xs">Mic</dt>
                    <dd className="truncate text-xs" title={live.micLabel ?? undefined}>
                        {live.micLabel ?? '\u2014'}
                    </dd>
                    <dt className="text-muted-foreground text-xs">Pipeline</dt>
                    <dd className="truncate text-xs">{pipelineName ?? '\u2014'}</dd>
                    <dt className="text-muted-foreground text-xs">Capture</dt>
                    <dd className="text-xs">
                        16 kHz mono {'\u00b7'} VAD auto-pause on {'\u00b7'} echo cancel on {'\u00b7'} noise suppression on
                    </dd>
                    {live.session ? (
                        <>
                            <dt className="text-muted-foreground text-xs">Session</dt>
                            <dd className="truncate font-mono text-xs" title={live.session.sessionId}>
                                {live.session.sessionId}
                            </dd>
                        </>
                    ) : null}
                </dl>

                <AudioMeter level={live.level} isCapturing={live.status === 'streaming'} isSpeaking={live.level > 5} isMuted={false} />

                <div className="flex flex-wrap items-center gap-2">
                    {live.session ? <StatusBadge label={`Sessions ${live.session.currentActive}/${live.session.maxConcurrent}`} colorRole="info" /> : null}
                    {live.session?.voiceProfileSeeded ? (
                        <StatusBadge label="Voice profile seeded" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
                    ) : null}
                    {live.reconnectAttempt > 0 ? <StatusBadge label={`Reconnect attempt ${live.reconnectAttempt}`} colorRole="warning" /> : null}
                    {live.droppedFrameCount > 0 ? <StatusBadge label={`Audio dropped ${live.droppedFrameCount}`} colorRole="warning" /> : null}
                </div>

                {/* ≥44px touch target on the record control (rule 11 §7). */}
                <Button variant="destructive" className="h-11 w-full" onClick={onStop} disabled={busy}>
                    <IconPlayerStopFilled aria-hidden />
                    Stop session
                </Button>

                <div className="text-muted-foreground flex flex-col gap-1 font-mono text-xs">
                    <span>
                        refresh-ticket on reconnect
                        {ticketRemainingSec !== null ? ` \u00b7 ticket expires in ${ticketRemainingSec}s` : ''}
                    </span>
                    <span>DELETE {'\u2026'}/stream/session/:sessionId on stop</span>
                </div>

                <p className="bg-warning/10 text-foreground rounded-md border px-2 py-1 text-xs">
                    Mic permission: {live.micPermission === 'unknown' ? 'prompt on first start' : live.micPermission}
                </p>
            </CardContent>
        </Card>
    );
}

export function TranscriptPane({ live }: { live: UseLiveSttSessionResult }) {
    const meta = STATUS_META[live.status];
    const scrollRef = useRef<HTMLOListElement | null>(null);

    // Autoscroll: pin the newest row while the session streams (frame 51 footer).
    useEffect(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [live.finals, live.partial]);

    return (
        <Card className="gap-4">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm leading-none font-semibold">
                    Live transcript{' '}
                    <span aria-hidden className="text-muted-foreground font-normal">
                        {'\u00b7'} WS ?sessionId&ticket
                    </span>
                </h2>
                <StatusBadge label={live.status === 'streaming' ? 'WS live' : meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                <ol ref={scrollRef} role="log" aria-label="Live transcript" className="bg-muted/50 flex max-h-80 min-h-40 flex-col gap-1.5 overflow-y-auto rounded-md border p-3">
                    {live.finals.length === 0 && !live.partial ? (
                        <li className="text-muted-foreground text-xs">Listening {'\u2014'} final and partial segments land here.</li>
                    ) : null}
                    {live.finals.map((row) => (
                        <li key={row.id} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 text-sm">
                            <span className="text-muted-foreground font-mono text-xs tabular-nums">{formatClock(row.receivedAt)}</span>
                            <span className="text-muted-foreground text-xs">final</span>
                            <span>
                                {row.speakerLabel ? <span className="text-muted-foreground mr-1 text-xs">{row.speakerLabel}:</span> : null}
                                {row.text}
                            </span>
                        </li>
                    ))}
                    {live.partial ? (
                        <li className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 text-sm">
                            <span className="text-muted-foreground font-mono text-xs tabular-nums">{formatClock(live.partial.receivedAt)}</span>
                            <span className="text-muted-foreground text-xs italic">partial</span>
                            <span className="text-muted-foreground italic">
                                {'\u2026'}
                                {live.partial.text}
                                <span aria-hidden className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-0.5 animate-pulse align-middle motion-reduce:animate-none" />
                            </span>
                        </li>
                    ) : null}
                </ol>
                <p className="text-muted-foreground text-xs">
                    {live.lastSeq !== null ? `seq ${live.lastSeq} \u00b7 ` : ''}
                    {live.lastLatencyMs !== null ? `latency ~${live.lastLatencyMs} ms \u00b7 ` : ''}
                    autoscroll
                </p>
            </CardContent>
        </Card>
    );
}

/**
 * Frame 51 streaming tab: session controls + the partial-vs-final WS
 * transcript stream, with the designed 429-quota / generic-4401 error states
 * and the no-session empty state.
 */
export function StreamingTab({
    live,
    pipelineName,
    canStart,
    onStart,
}: {
    live: UseLiveSttSessionResult;
    pipelineName: string | null;
    canStart: boolean;
    onStart: () => void;
}) {
    // 1 s tick drives the elapsed clock and the ticket countdown while a
    // session exists; idle screens don't pay for an interval.
    const [now, setNow] = useState(() => Date.now());
    const sessionActive = live.session !== null;
    useEffect(() => {
        if (!sessionActive) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [sessionActive]);

    if (live.quotaExceeded) {
        return <QuotaPanel onRetry={onStart} />;
    }

    const hasTranscripts = live.finals.length > 0 || live.partial !== null;

    if (live.status === 'error') {
        return (
            <div className="flex flex-col gap-4">
                <SessionErrorPanel message={live.error ?? 'The live session failed.'} onRestart={onStart} />
                {hasTranscripts ? <TranscriptPane live={live} /> : null}
            </div>
        );
    }

    if (live.status === 'idle' && !hasTranscripts) {
        return (
            <EmptyState
                icon={IconBroadcast}
                title="No live session"
                description="Pick a pipeline and start a session to stream microphone audio to stt-v2 in real time."
                action={
                    <Button onClick={onStart} disabled={!canStart} className="h-11">
                        <IconPlayerPlayFilled aria-hidden />
                        Start session
                    </Button>
                }
            />
        );
    }

    if (live.status === 'idle') {
        // Session ended but the transcript history stays for review.
        return (
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                    <Button onClick={onStart} disabled={!canStart} className="h-11">
                        <IconPlayerPlayFilled aria-hidden />
                        Start session
                    </Button>
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        <IconMicrophone aria-hidden className="size-3.5" />
                        Previous session transcript shown below.
                    </span>
                </div>
                <TranscriptPane live={live} />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {live.audioLostThisSession ? <DegradedBanner droppedFrameCount={live.droppedFrameCount} /> : null}
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                <SessionControlsCard live={live} pipelineName={pipelineName} now={now} onStop={() => void live.stop()} />
                <TranscriptPane live={live} />
            </div>
        </div>
    );
}
