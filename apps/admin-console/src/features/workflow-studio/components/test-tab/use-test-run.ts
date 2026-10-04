'use client';

/**
 * The Test tab's run controller (TASK-1036 §10.2).
 *
 * ONE source of truth: the ordered protocol-v2 events of the run's admin trace. Everything shown is
 * `foldRunEvents(events, n)`: `n` is every event while LIVE, and the playback cursor otherwise —
 * Pause freezes it, Step moves it one event, a clicked event jumps to it (time travel), Play walks
 * it back to live at the chosen speed. The run itself never pauses: the cursor is a VIEW.
 *
 * The latest run id of the definition is remembered in the query cache at start (so a remount
 * resumes the same trace from `after=0`), and its per-node feed when it ends (the inspector's
 * Last run tab and the picker samples).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCancelSandboxRun, useStartSandboxRun } from '@/shared/sandbox/api/hooks';
import { sandboxKeys } from '@/shared/sandbox/api/keys';
import { rememberLatestSandboxRun, useLatestSandboxRun, type LatestSandboxRun } from '@/shared/sandbox/api/latest-run';
import { foldRunEvents, nodeLastRunsOf, type RunView } from '@/shared/sandbox/api/run-fold';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import type { StartSandboxRunBody } from '@/shared/sandbox/api/types';
import { useRunTraceStream, type RunTraceStreamStatus } from '@/shared/sandbox/api/use-run-trace-stream';

export type PlaybackSpeed = 1 | 2 | 4;

const PLAYBACK_INTERVAL_MS = 400;
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

export interface TestRunController {
  runId: string | null;
  streamStatus: RunTraceStreamStatus;
  streamError: string | null;
  reconnect: () => void;
  /** Every delivered event of the run. */
  events: RunEvent[];
  /** The fold of every event. */
  live: RunView;
  /** `null` = live; otherwise how many events the view shows. */
  viewCount: number | null;
  /** The fold the surface renders (live, or at the cursor). */
  view: RunView;
  playing: boolean;
  speed: PlaybackSpeed;
  setSpeed: (speed: PlaybackSpeed) => void;
  /** Epoch ms when this tab started the run (for a ticking elapsed time); null after a resume. */
  startedLocalAt: number | null;
  starting: boolean;
  start: (body: StartSandboxRunBody) => Promise<string | null>;
  cancel: () => Promise<void>;
  cancelling: boolean;
  reset: () => void;
  pause: () => void;
  play: () => void;
  step: () => void;
  goLive: () => void;
  travelTo: (count: number) => void;
}

export function useTestRun(definitionId: string): TestRunController {
  const queryClient = useQueryClient();
  const latest = useLatestSandboxRun(definitionId);
  // Resume the definition's latest run on mount (a remounted tab replays its trace from `after=0`).
  const [runId, setRunId] = useState<string | null>(latest.runId);
  const [startedLocalAt, setStartedLocalAt] = useState<number | null>(null);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  const trace = useRunTraceStream(runId);
  const startMutation = useStartSandboxRun();
  const cancelMutation = useCancelSandboxRun();

  const events = trace.events;
  const live = useMemo(() => foldRunEvents(events, undefined, runId), [events, runId]);
  const cursor = viewCount === null ? null : Math.min(viewCount, events.length);
  const view = useMemo(() => (cursor === null ? live : foldRunEvents(events, cursor, runId)), [cursor, events, live, runId]);

  // Playback: walk the cursor back to live at the chosen speed (a timer callback, never an effect
  // body). The refs give handlers the latest values without re-arming the timer.
  const eventsLengthRef = useRef(events.length);
  const viewCountRef = useRef<number | null>(viewCount);
  useEffect(() => {
    eventsLengthRef.current = events.length;
    viewCountRef.current = viewCount;
  }, [events.length, viewCount]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const previous = viewCountRef.current;
      const next = previous === null ? null : previous + speed;
      if (next === null || next >= eventsLengthRef.current) {
        viewCountRef.current = null;
        setViewCount(null);
        setPlaying(false);
        return;
      }
      viewCountRef.current = next;
      setViewCount(next);
    }, PLAYBACK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, speed]);

  // Remember the finished run's per-node feed once per run.
  const rememberedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runId || !TERMINAL.has(live.status) || rememberedRef.current === runId) return;
    rememberedRef.current = runId;
    rememberLatestSandboxRun(queryClient, definitionId, { runId, nodes: nodeLastRunsOf(live) });
  }, [definitionId, live, queryClient, runId]);

  const start = useCallback(
    async (body: StartSandboxRunBody): Promise<string | null> => {
      const response = await startMutation.mutateAsync({ definitionId, body });
      setRunId(response.runId);
      setStartedLocalAt(Date.now());
      setViewCount(null);
      setPlaying(false);
      const previous = queryClient.getQueryData<LatestSandboxRun>(sandboxKeys.latestRun(definitionId));
      rememberLatestSandboxRun(queryClient, definitionId, { runId: response.runId, nodes: previous?.nodes ?? {} });
      return response.runId;
    },
    [definitionId, queryClient, startMutation],
  );

  const cancel = useCallback(async () => {
    if (!runId) return;
    await cancelMutation.mutateAsync({ definitionId, runId });
  }, [cancelMutation, definitionId, runId]);

  const reset = useCallback(() => {
    setRunId(null);
    setStartedLocalAt(null);
    setViewCount(null);
    setPlaying(false);
    const previous = queryClient.getQueryData<LatestSandboxRun>(sandboxKeys.latestRun(definitionId));
    rememberLatestSandboxRun(queryClient, definitionId, { runId: null, nodes: previous?.nodes ?? {} });
  }, [definitionId, queryClient]);

  const pause = useCallback(() => {
    setPlaying(false);
    if (viewCountRef.current === null) {
      viewCountRef.current = eventsLengthRef.current;
      setViewCount(eventsLengthRef.current);
    }
  }, []);

  const play = useCallback(() => {
    const previous = viewCountRef.current;
    if (previous === null || previous >= eventsLengthRef.current) {
      viewCountRef.current = null;
      setViewCount(null);
      setPlaying(false);
      return;
    }
    setPlaying(true);
  }, []);

  const step = useCallback(() => {
    setPlaying(false);
    const next = Math.min(eventsLengthRef.current, (viewCountRef.current ?? eventsLengthRef.current) + 1);
    viewCountRef.current = next;
    setViewCount(next);
  }, []);

  const goLive = useCallback(() => {
    setPlaying(false);
    viewCountRef.current = null;
    setViewCount(null);
  }, []);

  const travelTo = useCallback((count: number) => {
    setPlaying(false);
    viewCountRef.current = Math.max(0, count);
    setViewCount(Math.max(0, count));
  }, []);

  return {
    runId,
    streamStatus: trace.status,
    streamError: trace.error,
    reconnect: trace.reconnect,
    events,
    live,
    viewCount: cursor,
    view,
    playing,
    speed,
    setSpeed,
    startedLocalAt,
    starting: startMutation.isPending,
    start,
    cancel,
    cancelling: cancelMutation.isPending,
    reset,
    pause,
    play,
    step,
    goLive,
    travelTo,
  };
}
