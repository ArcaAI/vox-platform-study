/**
 * @arcaai/vox - useArcaAudio Hook (REFACTOR-01)
 *
 * Focused hook for audio capture, muting, and plugin control.
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback, useRef } from 'react';
import { useAgenticStore } from '../store';
import type { ContextItem, TranscriptionResult } from '../types';
import { AgenticError } from '../types';
import type { TranscriptSegment, AudioStartOptions, DualCaptureResult, ProviderSwitchInfo, ActivePipelineInfo } from '../types/audio';
import { CONTEXT_ENDPOINTS } from '../core/constants';
import type { ISDKLogger } from '../core/logger';
import { AudioContextManager, AudioMixer } from '@arcaai/room';
import { DualStreamRecorder } from '../core/DualStreamRecorder';

// Re-export the interface from useArca.ts
export type { UseArcaAudio } from './useArca';

/**
 * Structural (duck-typed) view of the streaming session manager reachable via
 * `pluginManager.getTranscriptionPipeline().getStreamingSessionManager()`.
 * `TranscriptionPipeline.getStreamingSessionManager()` (in `@arcaai/vox`
 * core, outside this file's edit scope) declares only the pre-586
 * `getSessionId`/`switchToFallback` members; this WIDENS that view locally so
 * `switchProvider` can reach the TASK-586 Lane D additions
 * (`switchProvider`/`setCompatSwitchEnabled`) on the real
 * `StreamingSessionManager` instance without changing the shared duck-typed
 * interface.
 */
type StreamingSessionManagerLike = {
  getSessionId(): string | null;
  switchToFallback?(): Promise<void>;
  switchProvider?(target: 'primary' | 'fallback'): Promise<void>;
  setCompatSwitchEnabled?(enabled: boolean): void;
};

/**
 * Vox-path mirror of the canonical `deriveSpeakerLabel`
 * (`@arcaai/applications` `services/stt/streaming/speaker-label.ts`).
 *
 * The admin streaming path reads the `speakerLabel` the streaming bridge derives
 * ONCE onto the wire. The vox capture path takes a DIFFERENT route (`@arcaai/stt`
 * `StreamingBackendSTTProvider` → `TranscriptionResult`) that today threads only
 * the raw `speakerId`, so this seam applies the SAME semantics locally instead of
 * surfacing a raw id: the `"unknown"` no-confident-match sentinel becomes a
 * clinician-facing label, anonymous `"Speaker N"` ids pass through verbatim, and
 * empty/missing ids yield no label. It NEVER fabricates a clinician/patient name
 * (identical PHI posture to the canonical mapping). Threading the bridge-derived
 * label through `@arcaai/stt` so this path can read it off the wire is a separate
 * follow-up.
 */
function deriveSpeakerLabel(speakerId?: string | null): string | undefined {
  if (typeof speakerId !== 'string') return undefined;
  const id = speakerId.trim();
  if (!id) return undefined;
  if (id.toLowerCase() === 'unknown') return 'Unknown speaker';
  return id;
}

/**
 * Liveness check for a single caller-supplied capture stream (TASK-612
 * Lane A, RC-3) — used both for `AudioStartOptions.sourceStreams` at start
 * and for `addSource({ stream })` at runtime.
 *
 * A stream with no audio track, or whose only track(s) have all already
 * ended (e.g. a stream reused after a prior session's `stop()`, or a caller
 * that stopped it directly), is otherwise ACCEPTED and produces a
 * structurally valid capture session whose uplink carries nothing — no
 * transcripts, no error, just silence on an open socket. Returns the
 * violation reason so callers can build a message naming it, or `null` when
 * the stream has at least one track with `readyState === 'live'`.
 */
/** Cadence of the live input-level meter (and the watchdog riding its tick). */
const LEVEL_METER_INTERVAL_MS = 100;
/**
 * Sustained zero-level window after which a STREAMING session is declared
 * silent (TASK-612 Lane D, RC-4): long enough that a pause between sentences
 * never trips it, short enough to be noticed before a consultation is lost.
 */
const SILENT_UPLINK_WATCHDOG_MS = 5000;

function injectedStreamLivenessViolation(stream: MediaStream): 'no audio track' | 'no live audio track' | null {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return 'no audio track';
  return audioTracks.some((track) => track.readyState === 'live') ? null : 'no live audio track';
}

/**
 * Focused hook for audio capture, muting, and plugin control.
 *
 * Extracted from useArca for better performance and maintainability (REFACTOR-01).
 *
 * @example
 * ```tsx
 * function AudioControls() {
 *   const audio = useArcaAudio();
 *
 *   return (
 *     <div>
 *       <button onClick={() => audio.start()}>Start</button>
 *       <button onClick={() => audio.stop()}>Stop</button>
 *       <button onClick={() => audio.mute()}>Mute</button>
 *       <div>Level: {audio.level}%</div>
 *       <div>Transcript: {audio.currentTranscript}</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useArcaAudio() {
  const store = useAgenticStore();

  // Get logger from store (create child for this hook)
  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaAudio');
  }, [store.logger]);

  // Capture-session resources that must survive between
  // start() and stop(): the N-source mixer for F3, and
  // the dual-capture recorder (+ its delivery callback) for F2.
  const mixerRef = useRef<AudioMixer | null>(null);
  /**
   * REF CONTRACT (TASK-597 lane A) — read this before touching teardown.
   *
   * Holds EVERY stream the current capture session owns, in resolved source
   * order: the primary mic, each extra mic, and any caller-injected
   * (file-backed) stream. It replaced the pre-597 single `secondaryStreamRef`,
   * which could only ever remember one stream and therefore leaked
   * `MediaStreamTrack`s the moment a third source existed — and a leaked track
   * keeps the browser's recording indicator lit after Stop.
   *
   * Invariants:
   *   - `startAudio` registers streams AS THEY ARE ACQUIRED, so a mid-way
   *     failure still leaves every already-open track reachable for cleanup.
   *   - Any teardown path must iterate this array, stop every SDK-OWNED
   *     track — skipping streams in `callerOwnedStreamsRef` (TASK-612
   *     OD-1a) — then reset it to `[]`. Nothing else needs to know how many
   *     sources there were.
   */
  const sourceStreamsRef = useRef<MediaStream[]>([]);
  /**
   * OWNERSHIP companion to `sourceStreamsRef` (TASK-612 Lane B, OD-1a).
   *
   * Membership means the CALLER built this stream (`sourceStreams`,
   * `addSource({ stream })`) and owns its lifecycle: every teardown path
   * unwires it but NEVER stops its tracks — stopping them destroyed the
   * integrator's reusable external-mic stream, so the next session found
   * every track `ended` (RC-3). SDK-opened (`getUserMedia`) streams are
   * absent from this set and released exactly as always.
   *
   * Reassigned fresh at every `startAudio`, so no tag outlives the session
   * that made it. A WeakSet on purpose: identity-only, never enumerated, and
   * it cannot retain a stream the session has forgotten.
   */
  const callerOwnedStreamsRef = useRef<WeakSet<MediaStream>>(new WeakSet());
  // Self-contained input-level meter (TASK-543): the transcription pipeline
  // never surfaced an amplitude to the store, so meters/waveforms sat at 0.
  // An AnalyserNode on the capture graph (analysis-only — never routed to the
  // destination, so it adds no playback) samples RMS into `store.setAudioLevel`.
  const levelMeterRef = useRef<{ analyser: AnalyserNode; source: MediaStreamAudioSourceNode; timer: ReturnType<typeof setInterval> } | null>(null);
  /**
   * LIVE mute flag for the meter's watchdog tick (TASK-612 Lane D). The timer
   * closure captures the render-time `store` snapshot, which goes stale the
   * moment mute changes — this ref is the imperative channel `muteAudio` /
   * `unmuteAudio` write, so the watchdog never warns about silence the
   * clinician asked for. Re-anchored to the store snapshot at each start.
   */
  const isMutedRef = useRef(false);
  // Live uplink-bitrate poller (TASK-543): samples the streaming STT transport's
  // cumulative bytes-sent once a second and publishes the delta*8 as bits/sec.
  const uplinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dualRecorderRef = useRef<DualStreamRecorder | null>(null);
  const onDualCaptureRef = useRef<((result: DualCaptureResult) => void) | undefined>(undefined);
  /**
   * The pipeline baseline the GATEWAY reported for this session (TASK-614),
   * captured by `onStreamingSessionCreated` during `pluginManager.initialize()`.
   * A ref, not state: it is written and read inside one `startAudio` pass, well
   * before any re-render. Cleared on start and stop so it can never leak a
   * previous session's engine into the next one.
   */
  const serverPipelineRef = useRef<ActivePipelineInfo | null>(null);

  // ---------------------------------------------------------------------------
  // Runtime source management (TASK-609)
  // ---------------------------------------------------------------------------
  /** Mixer source ids in mix order — the array published to `store.audioSourceIds`. */
  const sourceIdsRef = useRef<string[]>([]);
  /**
   * id → stream association for `sourceIdsRef` (TASK-611). `sourceStreamsRef`
   * is positional with no id of its own, so removing a source BY ID needs a
   * lookup to find which entry of that array to drop. Populated everywhere an
   * id is minted (`nextSourceId`'s two call sites: the initial mixer build and
   * `addSource`) and kept in lockstep with `sourceIdsRef` — same reset points,
   * same removal in `removeSource`.
   */
  const sourceIdToStreamRef = useRef<Map<string, MediaStream>>(new Map());
  /**
   * MONOTONIC id counter. Never reset within a session and never reused after a
   * removal: recycling `source-2` would let a stale id from a removed mic
   * address whatever took its place — silently re-gaining or dropping the wrong
   * microphone.
   */
  const sourceCounterRef = useRef(0);
  /** Session-wide `getUserMedia` processing switches, inherited by runtime adds. */
  const audioProcessingRef = useRef<Record<string, boolean>>({});
  /** Detach functions for the per-track `ended` listeners; run on teardown. */
  const endedListenersRef = useRef<(() => void)[]>([]);

  const nextSourceId = useCallback((): string => {
    sourceCounterRef.current += 1;
    const id = `source-${sourceCounterRef.current}`;
    sourceIdsRef.current = [...sourceIdsRef.current, id];
    return id;
  }, []);

  const publishSourceIds = useCallback(() => {
    store.setAudioSourceIds?.([...sourceIdsRef.current]);
  }, [store]);

  /**
   * Watch a capture source for DEVICE LOSS (TASK-609).
   *
   * A microphone unplugged mid-consultation ends its track: the graph stays
   * wired, the socket stays open, and the audio just stops. Nothing detected
   * that before, so it presented exactly like the "no data on the socket" class
   * of bug. Surfacing it as an `audioError` is deliberate — it IS an error, and
   * the alternative (auto-removing the source) would change the mix's master
   * gain underneath the user without their say-so.
   */
  const watchSourceForLoss = useCallback(
    (stream: MediaStream) => {
      const logger = getLogger();
      for (const track of stream.getAudioTracks?.() ?? []) {
        if (typeof track.addEventListener !== 'function') continue;
        const onEnded = () => {
          const label = track.label || 'unknown device';
          logger?.warn('Capture source ended — device disconnected or revoked', {
            operation: 'watchSourceForLoss',
            component: 'useArcaAudio',
            attributes: { label },
          });
          store.setAudioError(new Error(`Capture source ended: ${label}. The device was disconnected or its permission was revoked.`));
        };
        track.addEventListener('ended', onEnded);
        endedListenersRef.current.push(() => track.removeEventListener?.('ended', onEnded));
      }
    },
    [store, getLogger],
  );

  const releaseSourceWatchers = useCallback(() => {
    for (const detach of endedListenersRef.current) {
      try {
        detach();
      } catch {
        // A listener on an already-released track must not break teardown.
      }
    }
    endedListenersRef.current = [];
  }, []);

  // ==========================================================================
  // Audio Actions
  // ==========================================================================

  const startAudio = useCallback(
    async (options?: AudioStartOptions): Promise<void> => {
      const { pluginManager, consultation } = store;
      const logger = getLogger();
      if (!pluginManager) throw new Error('SDK not initialized');

      // CALL-TIME idempotence (TASK-597 follow-up). The compat layer drives ONE
      // audio graph through TWO hooks (`useAudioCapture.startRecording` and
      // `useArcaSpeechToText.startTranscription`), each guarded only by a
      // RENDER-TIME `isCapturing` snapshot — so a consumer that starts both in
      // one handler lands here twice, and the second pass would (a) OVERWRITE
      // `runtimeOptions` with its own option set (dropping e.g. the drain knobs
      // only the first caller carries) and (b) open a SECOND capture source via
      // getUserMedia. `pluginManager.initialized` is shared state flipped
      // synchronously with the capture lifecycle (true after `initialize`,
      // false after `destroy`), so it is the cross-hook truth the stale
      // closures are not. Optional-chained: test doubles without the getter
      // keep the pre-guard behaviour.
      //
      // TASK-612 Lane C (RC-2, OD-2a): the ignored call's contract now depends
      // on WHAT it was carrying. Capture-shaped options (`deviceId`,
      // `sourceStreams`, `dynamicSources`, ...) would have changed WHAT IS
      // RECORDED, so silently dropping them is a bug, not idempotence — that
      // branch still `logger.warn`s (log-based triage stays) and now ALSO
      // THROWS a named `AgenticError` ('CAPTURE_OPTIONS_DROPPED') so the
      // calling hook's existing catch → setError/onError path surfaces it,
      // instead of an integrator whose STT hook won the start race streaming
      // the default mic with no surfaced error. A call carrying ONLY options
      // the running session already applies (language, pipelineId) is still
      // the DESIGNED coordinated dual-hook path (compat drives one audio graph
      // through two hooks) — that stays a silent `logger.info` + return, not
      // an error.
      if (pluginManager.initialized === true) {
        // Everything in this list would have CHANGED WHAT IS RECORDED, and
        // dropping it silently is how "the UI shows my external mic selected
        // but the socket carries the built-in one" became a debuggable-only-
        // by-reading-the-source bug. Options the running session already
        // applies (language, pipelineId) stay at INFO — they are the normal
        // dual-hook path, not a mistake.
        const droppedOptions = (
          ['deviceId', 'secondaryDeviceId', 'additionalDeviceIds', 'sourceStreams', 'sourceGains', 'audioProcessing', 'dynamicSources'] as const
        ).filter((key) => options?.[key] !== undefined);
        const attributes = { language: options?.language, pipelineId: options?.pipelineId, ...(droppedOptions.length ? { droppedOptions } : {}) };
        if (droppedOptions.length) {
          logger?.warn(
            'startAudio ignored — capture already active; capture-shaped options were DROPPED. Start capture from the hook that carries the sources (see TASK-609).',
            {
              operation: 'startAudio',
              component: 'useArcaAudio',
              attributes,
            },
          );
          throw new AgenticError(
            'CAPTURE_OPTIONS_DROPPED',
            `useArcaAudio.start: capture is already active, so this call's capture-shaped option(s) were dropped — ${droppedOptions.join(', ')}. ` +
              'Start capture from the hook that carries the sources BEFORE starting transcription (e.g. start capture — startRecording()/addSource — before startTranscription()).',
          );
        }
        logger?.info('startAudio ignored — capture already active (coordinated dual-hook start)', {
          operation: 'startAudio',
          component: 'useArcaAudio',
          attributes,
        });
        return;
      }

      // …and with no server pipeline baseline carried over (TASK-614): the
      // previous session's engine must never be reported for this one.
      serverPipelineRef.current = null;

      // A new capture session starts with a clean source registry (TASK-609):
      // ids restart at `source-1`, and nothing from the previous session's
      // mixer can be addressed by a stale id held by the UI.
      sourceIdsRef.current = [];
      sourceIdToStreamRef.current.clear();
      sourceCounterRef.current = 0;
      releaseSourceWatchers();

      // A new capture session starts with a clean audio-drop signal.
      // Reset BEFORE audio flows (the session-sticky latch clears on start/stop
      // only, so it survives reconnect but never leaks across capture sessions).
      store.resetAudioDropped();
      // …and with a clean audio-signal verdict; the watchdog's live mute
      // channel re-anchors to the snapshot (TASK-612 Lane D).
      store.setAudioSignalState?.('ok');
      isMutedRef.current = store.isMuted === true;

      if (options?.language) {
        store.setAudioLanguage(options.language);
      }
      // TASK-587 — remember the end-user language mode so a reconnect/fallback
      // restart re-applies it (mirrors how `audioLanguage` is used on line 564).
      if (options?.languageMode) {
        store.setSttLanguageMode(options.languageMode);
      }

      // Forward per-capture options to the plugin manager
      // BEFORE initialize so the streaming transport can be built for the
      // STT stage when a `pipelineId` is provided.
      pluginManager.setRuntimeOptions?.({
        pipelineId: options?.pipelineId,
        consultationId: consultation?.id,
        // Order-independent language: mirror the `languageMode` store fallback
        // below so a capture-first start (compat `useAudioCapture` starting the
        // mic before `useArcaSpeechToText.startTranscription()` runs) still pins
        // the end-user's selection published to the store. The LOCAL STT path
        // reads `language` (not `languageMode`), so without this a non-default
        // pick would degrade to the DEFAULT locale there. `audioLanguage` is the
        // per-capture SDK language, so this honours the documented
        // `runtimeOptions > userPreferences` precedence. (TASK-587)
        language: options?.language ?? store.audioLanguage,
        // Fall back to the store-held mode so a start triggered WITHOUT a
        // languageMode (e.g. compat `useAudioCapture.startRecording()`, which
        // only knows the pipelineId) still honours the user's selection
        // published by `useArcaSpeechToText`. The backend resolves the mode to
        // the actual language, so this alone is sufficient. (TASK-587 compat
        // start-coordination fix.)
        // When nobody has picked a mode, default to 'auto' so the session
        // AUTO-DETECTS the language instead of a hardcoded default — pipelines
        // no longer pin a language (TASK-598). A dev/end-user pick still wins.
        languageMode: options?.languageMode ?? store.sttLanguageMode ?? 'auto',
        // Pre-start engine selection (TASK-586). Start-time only — the session
        // opens on the tenant-admin default provider when 'fallback'.
        startOn: options?.startOn,
        // Stop-drain ceiling (TASK-597 follow-up #4). Non-positive values are
        // dropped HERE as well as at the provider, so a `0`/`-1` from a caller
        // can never be mistaken for "drain forever" or "do not drain".
        ...(typeof options?.drainTimeoutMs === 'number' && options.drainTimeoutMs > 0 ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
        // Stop-drain quiet window (TASK-597). Guarded on `>= 0`, NOT on
        // truthiness: `0` is the documented "disable the early resolve" value,
        // so a `!== 0` / falsy guard here would silently drop exactly the
        // setting a caller went out of their way to ask for. Only negatives
        // (meaningless) fall back to the client default.
        ...(typeof options?.quietWindowMs === 'number' && options.quietWindowMs >= 0 ? { quietWindowMs: options.quietWindowMs } : {}),
      });

      const timer = logger?.startOperation('startAudio', {
        component: 'useArcaAudio',
        sdk: { consultationId: consultation?.id },
        attributes: { language: options?.language, pipelineId: options?.pipelineId },
      });

      try {
        // ------------------------------------------------------------------
        // Resolve the capture sources (TASK-597).
        //
        // ONE code path serves all four source modes — a single mic, N mics
        // mixed, one file-backed stream, N file-backed streams mixed — because
        // everything downstream (mixer → noise filter → VAD → STT) is fed from
        // the SAME resolved list. There is deliberately no separate "file" path:
        // a simulated recording must exercise the identical graph a mic does,
        // or it proves nothing about the real pipeline.
        //
        //   • `sourceStreams` non-empty → the caller already built the streams
        //     (file playback, a test double, a remote track). getUserMedia is
        //     NOT called, and the deviceId fields are ignored.
        //   • otherwise → `[deviceId, secondaryDeviceId, ...additionalDeviceIds]`
        //     with empties dropped and duplicates removed. An EMPTY list means
        //     "the default mic" and still issues the pre-597 `{ audio: true }`
        //     request, so a plain `start()` is unchanged.
        // ------------------------------------------------------------------
        const injectedStreams = (options?.sourceStreams ?? []).filter((s): s is MediaStream => Boolean(s));

        // TASK-612 Lane A (RC-3) — fail loudly on a dead/trackless injected
        // stream instead of silently streaming zeros. This runs BEFORE
        // anything teardown-sensitive is armed: source-loss watchers, the
        // level meter, `sourceStreamsRef` registration (a few lines down),
        // and any `getUserMedia` call. A rejection here therefore leaves no
        // capture state to unwind and never touches a caller-owned track —
        // there is nothing registered yet for the failed-start cleanup below
        // to reach.
        if (injectedStreams.length > 0) {
          const violations = injectedStreams
            .map((s, index) => {
              const reason = injectedStreamLivenessViolation(s);
              return reason ? `sourceStreams[${index}]: ${reason}` : null;
            })
            .filter((v): v is string => v !== null);
          if (violations.length > 0) {
            throw new AgenticError(
              'SOURCE_STREAM_NOT_LIVE',
              `useArcaAudio.start: sourceStreams contains stream(s) that cannot be used — ${violations.join('; ')}. ` +
                'Each entry needs a live audio track; build (and resume) the stream before calling start().',
            );
          }
        }

        const deviceIds =
          injectedStreams.length > 0
            ? []
            : Array.from(
                new Set(
                  [options?.deviceId, options?.secondaryDeviceId, ...(options?.additionalDeviceIds ?? [])].filter(
                    (id): id is string => typeof id === 'string' && id.trim().length > 0,
                  ),
                ),
              );

        // Browser audio-processing switches (TASK-608), resolved ONCE per
        // session and parked on a ref: a mic added at runtime (TASK-609) must
        // arrive under the SAME constraints, or the mix ends up half-DSP'd.
        // Only stated keys are kept, so an empty/omitted object leaves the
        // request shape untouched — `{ audio: true }` for the default mic, not
        // `{ audio: {} }`, which is a different request that every pre-608
        // integrator's behaviour hangs off.
        {
          const processing: Record<string, boolean> = {};
          for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const) {
            const value = options?.audioProcessing?.[key];
            if (typeof value === 'boolean') processing[key] = value;
          }
          audioProcessingRef.current = processing;
        }

        // Register the array on the teardown ref FIRST and push into it as each
        // stream is acquired — see the `sourceStreamsRef` contract. A rejection
        // on the third getUserMedia must not orphan the first two open mics.
        const sourceStreams: MediaStream[] = [];
        sourceStreamsRef.current = sourceStreams;
        // Ownership snapshot for THIS session (OD-1a): injected streams are
        // caller-owned; everything the SDK opens below is SDK-owned. Fresh
        // WeakSet per start, so a stream injected last session but SDK-opened
        // this one (or vice versa) cannot inherit a stale tag.
        callerOwnedStreamsRef.current = new WeakSet(injectedStreams);

        if (injectedStreams.length > 0) {
          logger?.debug('Using caller-supplied source streams (getUserMedia skipped)', {
            operation: 'startAudio',
            component: 'useArcaAudio',
            attributes: { sourceCount: injectedStreams.length },
          });
          sourceStreams.push(...injectedStreams);
        } else {
          logger?.debug('Requesting microphone access', {
            operation: 'startAudio',
            component: 'useArcaAudio',
            attributes: { deviceCount: deviceIds.length },
          });
          const processing = audioProcessingRef.current;
          const hasProcessing = Object.keys(processing).length > 0;

          if (deviceIds.length === 0) {
            sourceStreams.push(await navigator.mediaDevices.getUserMedia({ audio: hasProcessing ? { ...processing } : true }));
          } else {
            // Sequential on purpose: browsers serialize device-permission
            // prompts anyway, and a parallel Promise.all would lose track of
            // which streams opened before a later one rejected.
            for (const id of deviceIds) {
              sourceStreams.push(await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, ...processing } }));
            }
          }
        }

        // Watch every source for device loss (TASK-609) — before anything can
        // fail below, so a mic that disappears during initialize is still seen.
        sourceStreams.forEach(watchSourceForLoss);

        // The first source is the session's `activeStream` (what mute/unmute and
        // the level meter act on), exactly as the primary mic was pre-597.
        const stream = sourceStreams[0];

        const ctxManager = AudioContextManager.getInstance({ sampleRate: 48000 });
        const audioContext = await ctxManager.acquire();

        store.setActiveStream(stream);
        store.setActiveAudioContext(audioContext);

        // Whether this session routes through the mixer — decided once here and
        // reused below, because it also decides WHO owns the per-source levels
        // (the mixer's analysers, or the single-source meter). Two writers on
        // that array make it flap.
        const usesMixer = sourceStreams.length > 1 || options?.dynamicSources === true;

        // With exactly ONE source there is no mixer to tap, and none is needed:
        // that source IS the whole mix, so the meter below is already a
        // truthful per-source level and is published as a 1-entry array. With
        // several sources the mixer's per-source analysers own that array (see
        // the mixer block further down) and this meter stays the MIXED level.
        // (…unless a mixer exists anyway because runtime source changes were
        // requested — then its analysers own the per-source array, TASK-609.)
        const isSingleSource = sourceStreams.length === 1 && !usesMixer;

        // Live input-level meter — best-effort + guarded so a runtime without
        // Web Audio analysis (or a test double) simply leaves the level at 0.
        // The silent-uplink watchdog (TASK-612 Lane D) rides this meter's
        // tick, so where the meter is unavailable the watchdog is too.
        try {
          if (typeof audioContext.createMediaStreamSource === 'function' && typeof audioContext.createAnalyser === 'function') {
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            const source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser); // analysis only — deliberately NOT connected to destination
            if (typeof analyser.getFloatTimeDomainData === 'function') {
              const buffer = new Float32Array(analyser.fftSize);
              // Silent-uplink watchdog (TASK-612 Lane D, RC-4) — rides this
              // same tick rather than a second timer. Streaming-only: with no
              // pipeline there is no uplink to be silent on.
              const streamingSession = Boolean(options?.pipelineId);
              let watchdogZeroTicks = 0;
              let watchdogSilentEpisode = false;
              const watchdogTickLimit = SILENT_UPLINK_WATCHDOG_MS / LEVEL_METER_INTERVAL_MS;
              const timer = setInterval(() => {
                try {
                  analyser.getFloatTimeDomainData(buffer);
                  let sumSquares = 0;
                  for (let i = 0; i < buffer.length; i += 1) sumSquares += buffer[i] * buffer[i];
                  const rms = Math.sqrt(sumSquares / buffer.length);
                  // Map speech-range RMS (~0..0.4) to a 0..100 meter with a gentle gain + ceiling.
                  const level = Math.min(100, Math.round(rms * 250));
                  store.setAudioLevel(level);
                  if (isSingleSource) store.setAudioSourceLevels?.([level]);

                  // A sustained zero level on an UNMUTED streaming session
                  // means the socket is carrying structurally valid silence —
                  // the RC-4 failure class nothing else surfaces. One warn per
                  // episode; recovery is silent and re-arms the episode.
                  if (streamingSession) {
                    if (level > 0) {
                      watchdogZeroTicks = 0;
                      if (watchdogSilentEpisode) {
                        watchdogSilentEpisode = false;
                        store.setAudioSignalState?.('ok');
                      }
                    } else if (isMutedRef.current) {
                      // Intentional silence — and the counter restarts, so an
                      // unmute gets a fresh full window before any warning.
                      watchdogZeroTicks = 0;
                    } else {
                      watchdogZeroTicks += 1;
                      if (!watchdogSilentEpisode && watchdogZeroTicks >= watchdogTickLimit) {
                        watchdogSilentEpisode = true;
                        store.setAudioSignalState?.('silent');
                        logger?.warn(
                          `Streaming session has sent silence for ${SILENT_UPLINK_WATCHDOG_MS / 1000}s — likely a wrong/default microphone, an OS-muted device, a suspended caller AudioContext behind an injected stream, or browser echo-cancellation/noise-suppression/AGC zeroing a virtual device.`,
                          { operation: 'silentUplinkWatchdog', component: 'useArcaAudio' },
                        );
                      }
                    }
                  }
                } catch {
                  // A transient analyser read error must never break capture.
                }
              }, LEVEL_METER_INTERVAL_MS);
              levelMeterRef.current = { analyser, source, timer };
            } else {
              source.disconnect();
            }
          }
        } catch (levelError) {
          logger?.debug('Live level meter unavailable', { operation: 'startAudio', component: 'useArcaAudio', error: levelError as Error });
        }

        // More than one source → mix them all into ONE uplink stream via
        // @arcaai/room's AudioMixer (GainNode summation with 1/sqrt(N) master
        // normalization), then feed the single mixed track to the
        // noise-filter/VAD/STT pipeline. Exactly one source is fed straight
        // through with no mixer node in the graph — the pre-597 behaviour of
        // `start()` / `start({ deviceId })`.
        let track = stream.getAudioTracks()[0];
        // Defensive (TASK-612 RC-3) — every INJECTED stream was already
        // validated above, and a getUserMedia stream should always carry the
        // track it was requested with, but an unguarded index read here used
        // to let a trackless first source through as `undefined`: capture
        // "succeeded" (pluginManager.initialize(undefined, …) resolves,
        // isCapturing flips true) with no signal on the wire and no error
        // anywhere. Fail loudly instead.
        if (!track) {
          throw new AgenticError('SOURCE_STREAM_NOT_LIVE', 'useArcaAudio.start: capture source has no audio track.');
        }
        // A mixer is built for N > 1 sources — and ALSO for a single source when
        // the caller opted into runtime source changes (TASK-609). The reason is
        // structural: the pipeline is initialized with ONE track and the
        // transport hangs off it, so sources can only be added or dropped
        // mid-session when that track is the mixer's stable output. Without the
        // opt-in a single source is still fed straight through (no mixer node at
        // all), preserving the pre-597 graph exactly.
        if (usesMixer) {
          const mixer = new AudioMixer(audioContext);
          sourceStreams.forEach((source, index) => {
            const gain = options?.sourceGains?.[index];
            const id = nextSourceId();
            sourceIdToStreamRef.current.set(id, source);
            mixer.addSource(id, source, typeof gain === 'number' && Number.isFinite(gain) ? gain : 1.0, {
              // Caller-owned sources survive removal/dispose (OD-1a): the
              // mixer unwires them but must not stop their tracks.
              stopTracksOnRemove: !callerOwnedStreamsRef.current.has(source),
            });
          });
          mixerRef.current = mixer;
          publishSourceIds();

          // PER-SOURCE input levels (TASK-597 follow-up #2).
          //
          // The mixer is the only object that still holds the inputs as
          // separate signals — one node chain each, before the summation. An
          // analysis-only AnalyserNode per chain therefore answers "WHICH mic
          // is speaking", which `store.audioLevel` (one meter on the mixed
          // graph) structurally cannot. Published index-aligned with the
          // resolved source order, so `audioSourceLevels[i]` is the level of
          // source `i` — the same index `sourceGains` uses.
          //
          // Optional-called: the mixer double used by several existing suites
          // predates these methods, and a missing per-source signal must
          // degrade to "no attribution available" (an empty array), never throw.
          const monitoring =
            mixer.startLevelMonitoring?.({
              // Same cadence as the mixed meter above. N analysers on one timer
              // — the cost is N cheap RMS reads per 100 ms, not N timers.
              intervalMs: 100,
              onLevels: (levels) => store.setAudioSourceLevels?.(levels.map((entry) => entry.level)),
            }) ?? false;
          if (!monitoring) {
            // Be explicit rather than leaving a stale array: consumers read `[]`
            // as "this runtime gives no per-source signal".
            store.setAudioSourceLevels?.([]);
            logger?.debug('Per-source level monitoring unavailable', {
              operation: 'startAudio',
              component: 'useArcaAudio',
            });
          }

          const mixedTrack = mixer.getMixedTrack();
          if (mixedTrack) track = mixedTrack;

          logger?.debug('Mixed multi-source capture inputs', {
            operation: 'startAudio',
            component: 'useArcaAudio',
            attributes: {
              sourceCount: sourceStreams.length,
              fromFileStreams: injectedStreams.length > 0,
              deviceIds,
            },
          });
        }

        // Set up plugin callbacks
        pluginManager.setCallbacks({
          onTranscription: (result: TranscriptionResult) => {
            if (result.isFinal) {
              store.setCurrentTranscript('');

              // OD-3a (TASK-612): a whitespace-only final carries no clinical
              // value, so suppress the segment, the context POST, and the NER
              // trigger below — the interim clear above still runs, since the
              // interim window did end.
              if (!result.text?.trim()) {
                logger?.debug('Whitespace-only final suppressed', {
                  operation: 'onTranscription',
                  component: 'useArcaAudio',
                });
                return;
              }

              // `startTime`/`endTime` are seconds relative to stream start. When
              // a result carries no VAD/streaming offset, fall back to 0 — NOT
              // `Date.now()`, whose epoch-millisecond magnitude would be
              // mis-rendered as an absurd `mm:ss` timestamp downstream (TASK-591).
              const segment: TranscriptSegment = {
                text: result.text,
                startTime: result.vadStreamStartSec ?? 0,
                endTime: result.vadStreamEndSec ?? 0,
                isFinal: true,
                // Derive the canonical display label instead of
                // surfacing the raw diarizer id (so the `"unknown"` sentinel
                // never reaches the clinician verbatim).
                speakerLabel: deriveSpeakerLabel(result.speakerId),
                confidence: result.confidence,
                language: result.language,
                // Carry word-level timings through to
                // the store so consumers read words from audio.transcriptSegments.
                words: result.words,
                // Per-utterance pipeline provenance (TASK-613).
                // Spread-conditional so an older backend leaves the key absent
                // rather than writing `undefined` into every stored segment.
                ...(result.pipelineId ? { pipelineId: result.pipelineId } : {}),
              };
              store.addTranscriptSegment(segment);

              // Auto-add transcription to context if consultation active
              const { consultation, apiClient } = store;
              if (consultation && apiClient) {
                logger?.debug('Adding final transcription to context', {
                  operation: 'onTranscription',
                  component: 'useArcaAudio',
                  sdk: { consultationId: consultation.id },
                  attributes: { textLength: result.text.length, speakerId: result.speakerId },
                });
                apiClient
                  .post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
                    type: 'TRANSCRIPT',
                    content: result.text,
                    source: 'TRANSCRIPTION',
                    structuredData: {
                      segments: result.segments ?? result.timestamps,
                      speakerId: result.speakerId,
                    },
                  })
                  .then((item) => store.addContextItem(item))
                  .catch((error) => {
                    logger?.error('Failed to add transcription to context', {
                      operation: 'onTranscription',
                      component: 'useArcaAudio',
                      error: error as Error,
                      sdk: { consultationId: consultation.id },
                    });
                  });
              }

              // NER-L-02: Auto-trigger NER on final transcriptions via knowledge pipeline
              const knowledgePipeline = pluginManager.getKnowledgePipeline();
              if (knowledgePipeline && knowledgePipeline.state.isReady) {
                logger?.debug('Auto-triggering NER on final transcription', {
                  operation: 'onTranscription',
                  component: 'useArcaAudio',
                  attributes: { textLength: result.text.length },
                });
                knowledgePipeline
                  .process({ text: result.text })
                  .then((output) => {
                    if (output.entities?.length) {
                      store.addEntities(output.entities);
                      logger?.debug('Auto-NER entities extracted', {
                        operation: 'onTranscription',
                        component: 'useArcaAudio',
                        attributes: { entityCount: output.entities.length },
                      });
                    }
                  })
                  .catch((error) => {
                    logger?.error('Auto-NER failed on transcription', {
                      operation: 'onTranscription',
                      component: 'useArcaAudio',
                      error: error as Error,
                    });
                  });
              }
            } else {
              store.setCurrentTranscript(result.text);
            }
          },
          onVADEvent: (event) => {
            store.setIsSpeaking(event.type === 'speech-start');
          },
          onError: (error, plugin) => {
            logger?.error(`Plugin error: ${plugin}`, {
              operation: 'onPluginError',
              component: 'useArcaAudio',
              error: error,
              attributes: { plugin },
            });
            store.setAudioError(error);
          },
          // An outbound audio frame was dropped at the streaming STT
          // client's backpressure watermark. The dropped PCM never reached the
          // durable transcript, so latch the session loss (survives reconnect)
          // and bump the per-session count for the degraded-connection signal.
          onAudioDrop: () => {
            store.markAudioLost();
            store.incrementDroppedFrames();
          },
          // Streaming connection-health transitions from the STT client's
          // reconnect callbacks (TASK-567 Phase F). `switched_fallback` is set by
          // onProviderSwitched below, not here, so a post-switch reconnect that
          // reports `connected` never erases the durable `activePipeline.isFallback`.
          onSttConnectionState: (state) => {
            store.setSttConnectionState(state);
          },
          // The backend swapped the session's ASR engine (TASK-586 Lane D:
          // BIDIRECTIONAL — primary→fallback OR fallback→primary). The
          // direction is READ from the frame, in descending order of certainty
          // (TASK-614 D-4):
          //
          //   1. `isFallback` — the backend said so outright.
          //   2. `active` — the backend named the live engine.
          //   3. the pipeline id — this session asked for `options.pipelineId`,
          //      and the frame names what is live now; if they match, this is a
          //      return to the primary, not a fallback.
          //   4. only with none of the above: assume fallback. On a backend old
          //      enough to send neither field, the one-way primary→fallback
          //      auto-switch is the only switch that existed.
          //
          // Step 3 exists because steps 1–2 were unreachable until TASK-614
          // fixed the bridge, which made step 4 run on EVERY switch — latching
          // sessions that had returned to their selected pipeline as "fallback"
          // for the rest of their life.
          // The gateway echoed the RESOLVED pipeline + the engine it actually
          // opened on (TASK-614). Fires during `initialize()`, i.e. BEFORE the
          // `setActivePipeline` below, so the ref is what that line reads.
          // Also written to the store here so a consumer subscribed before the
          // start resolves sees the truth immediately.
          onStreamingSessionCreated: ({ pipelineId, isFallback }) => {
            serverPipelineRef.current = { id: pipelineId, name: pipelineId, isFallback };
            store.setActivePipeline(serverPipelineRef.current);
          },
          onProviderSwitched: (info) => {
            const raw = info as ProviderSwitchInfo & { active?: 'primary' | 'fallback'; isFallback?: boolean };
            const requestedPipelineId = options?.pipelineId;
            const isFallback =
              raw.isFallback !== undefined
                ? raw.isFallback
                : raw.active !== undefined
                  ? raw.active === 'fallback'
                  : requestedPipelineId && info.toPipeline
                    ? info.toPipeline !== requestedPipelineId
                    : true;
            // A switch BACK to primary un-latches the durable fallback flag and
            // returns the connection to the nominal `connected` state — the
            // TASK-568 durable latch was one-way by construction; this is the
            // explicit un-latch path for the new primary-direction frame.
            store.setSttConnectionState(isFallback ? 'switched_fallback' : 'connected');
            store.setActivePipeline({ id: info.toPipeline, name: info.toPipeline, isFallback });
            logger?.info('Streaming provider switched', {
              operation: 'onProviderSwitched',
              component: 'useArcaAudio',
              attributes: { from: info.fromPipeline, to: info.toPipeline, reason: info.reason, isFallback },
            });
          },
        });

        // Initialize plugins
        await pluginManager.initialize(track, audioContext);

        store.setIsCapturing(true);
        store.setAudioPlugins(pluginManager.getStates());
        store.setAudioError(null);

        // Reset the streaming STT connection signal for the new session and
        // record the active pipeline (backend workflow only — local STT has no
        // pipeline).
        //
        // SERVER-derived when the gateway echoed the resolved baseline
        // (TASK-614): the REQUEST is silent about a caller that sent no
        // pipelineId (the gateway resolves one — the session then had a null
        // `activePipeline` for its whole life), about a session opened on the
        // fallback by `startOn`, and about one opened there because the primary
        // ASR failed to load. `serverPipelineRef` is filled by
        // `onStreamingSessionCreated` DURING `initialize()` above, so it is
        // already set here when the backend supports the echo.
        //
        // Falls back to the request-derived value for an older gateway — a new
        // SDK must keep working there, unchanged.
        store.setSttConnectionState('connected');
        store.setActivePipeline(
          serverPipelineRef.current ??
            (options?.pipelineId ? { id: options.pipelineId, name: options.pipelineId, isFallback: options?.startOn === 'fallback' } : null),
        );

        // Uplink-bitrate poll — the streaming STT stage exists after initialize().
        // Sample cumulative bytes-sent each second; publish the delta as bits/sec.
        {
          let lastUplinkBytes = 0;
          uplinkTimerRef.current = setInterval(() => {
            try {
              const bytes = pluginManager.getTranscriptionPipeline?.()?.getUplinkBytesSent?.() ?? 0;
              const deltaBytes = Math.max(0, bytes - lastUplinkBytes);
              lastUplinkBytes = bytes;
              store.setAudioUplinkBitrate(deltaBytes * 8);
            } catch {
              // A diagnostics read must never break capture.
            }
          }, 1000);
        }

        // Dual capture (RAW + PROCESSED) for the LOCAL
        // workflow. Record the pre-noise-filter input (getRawInputTrack) and the
        // post-filter pipeline output (getProcessedTrack) in parallel; the blobs
        // are delivered on stop() via the onDualCapture callback.
        const workflowMode = store.preferences?.workflowMode ?? 'local';
        if (options?.dualCaptureEnabled && workflowMode !== 'remote') {
          const pipeline = pluginManager.getTranscriptionPipeline?.();
          const rawTrack = pipeline?.getRawInputTrack?.();
          const processedTrack = pipeline?.getProcessedTrack?.();
          if (rawTrack && processedTrack) {
            const recorder = new DualStreamRecorder(rawTrack, processedTrack);
            recorder.start();
            dualRecorderRef.current = recorder;
            onDualCaptureRef.current = options.onDualCapture;
            logger?.info('Dual capture started', {
              operation: 'startAudio',
              component: 'useArcaAudio',
              sdk: { consultationId: consultation?.id },
            });
          } else {
            logger?.warn('Dual capture requested but pipeline tracks unavailable', {
              operation: 'startAudio',
              component: 'useArcaAudio',
            });
          }
        }

        timer?.end(true, {
          attributes: {
            sampleRate: audioContext.sampleRate,
            trackLabel: track.label,
          },
        });

        logger?.info('Audio capture started', {
          operation: 'startAudio',
          component: 'useArcaAudio',
          success: true,
          sdk: { consultationId: consultation?.id },
        });
      } catch (error) {
        // Detach the loss watchers first, or the cleanup below trips them and
        // overwrites the REAL start error with "device disconnected" (TASK-609).
        releaseSourceWatchers();
        sourceIdsRef.current = [];
        sourceIdToStreamRef.current.clear();
        store.setAudioSourceIds?.([]);

        // A failed start must not leave SDK-OPENED microphones live. Before
        // 597 a rejection after the first getUserMedia (a second device that
        // disappeared, a pipeline that failed to initialize) left the acquired
        // track live and the browser's recording indicator lit, because only
        // stop() — which the caller never reaches on a throw — released it.
        // Caller-owned (injected) streams are skipped: the failure is the
        // SDK's, and destroying the caller's reusable stream over it was
        // RC-3 (TASK-612 OD-1a).
        for (const source of sourceStreamsRef.current) {
          if (callerOwnedStreamsRef.current.has(source)) continue;
          source.getTracks().forEach((t) => t.stop());
        }
        sourceStreamsRef.current = [];
        // …and it must not leave a level-sampling timer running either. Both
        // meters are pure diagnostics with no `stop()` path of their own on a
        // failed start, so a throw after they were armed (e.g. plugin
        // initialize rejecting) would leave them ticking for the life of the
        // page against a graph that no longer exists (TASK-597 follow-up #2).
        // Only the TIMERS/taps are released here — track teardown is the loop
        // above, deliberately left as the single place that stops tracks.
        if (levelMeterRef.current) {
          clearInterval(levelMeterRef.current.timer);
          try {
            levelMeterRef.current.source.disconnect();
            levelMeterRef.current.analyser.disconnect();
          } catch {
            // disconnect after context close can throw on some platforms — ignore.
          }
          levelMeterRef.current = null;
        }
        mixerRef.current?.stopLevelMonitoring?.();
        store.setAudioSourceLevels?.([]);
        timer?.error(error as Error);
        store.setAudioError(error as Error);
        throw error;
      }
    },
    [store, getLogger, nextSourceId, publishSourceIds, watchSourceForLoss, releaseSourceWatchers],
  );

  /**
   * Add a capture source to the LIVE mix (TASK-609).
   *
   * The mixed track the pipeline reads does not change identity when a source
   * joins, so the STT stage, the WebSocket session and the transcript continue
   * uninterrupted — which is the entire point: before this, "plug in the room
   * mic" meant stop() + start() and a torn-down session mid-consultation.
   *
   * Requires a mixer, i.e. a session started with several sources or with
   * `dynamicSources: true`. A single-source session feeds the device track
   * straight into the pipeline, and swapping THAT would mean re-initializing
   * the pipeline — the very teardown this API exists to avoid. The error says
   * so rather than silently doing nothing.
   *
   * @returns the new source id — the handle for `removeSource` / `setSourceGain`.
   */
  const addSource = useCallback(
    async (input: { deviceId?: string; stream?: MediaStream; gain?: number }): Promise<string> => {
      const logger = getLogger();
      if (!store.isCapturing || store.pluginManager?.initialized !== true) {
        throw new Error('useArcaAudio.addSource: no active capture session. Call start() first.');
      }
      const mixer = mixerRef.current;
      if (!mixer) {
        throw new Error(
          'useArcaAudio.addSource: this capture session has no mixer, so its sources cannot be changed. ' +
            'Start with `dynamicSources: true` (or with more than one source) to enable runtime source changes.',
        );
      }

      // A caller-built stream is used as-is; a deviceId is opened under the
      // SAME processing constraints the session started with (TASK-608), so a
      // late-joining mic cannot arrive DSP'd into a raw-capture mix.
      let stream = input.stream;
      if (!stream) {
        if (!input.deviceId) throw new Error('useArcaAudio.addSource: provide either `deviceId` or `stream`.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: input.deviceId }, ...audioProcessingRef.current } });
      } else {
        // TASK-612 Lane A (RC-3) — the same liveness contract `start()`
        // applies to `sourceStreams`, extended to this runtime seam. Checked
        // BEFORE `nextSourceId()` / `mixer.addSource()` below, so a rejected
        // add mutates NEITHER the published source-id registry nor the
        // mixer — the running session is left fully usable.
        const reason = injectedStreamLivenessViolation(stream);
        if (reason) {
          throw new AgenticError('SOURCE_STREAM_NOT_LIVE', `useArcaAudio.addSource: injected stream has ${reason}.`);
        }
      }

      const gain = typeof input.gain === 'number' && Number.isFinite(input.gain) ? input.gain : 1.0;
      // Ownership is decided by PROVENANCE (OD-1a): a caller-built stream is
      // caller-owned — the mixer must not stop its tracks on removal and the
      // teardown loops skip it (see the REF CONTRACT). A deviceId source was
      // opened by the SDK right above, so the SDK releases it.
      if (input.stream) callerOwnedStreamsRef.current.add(input.stream);
      const id = nextSourceId();
      try {
        mixer.addSource(id, stream, gain, { stopTracksOnRemove: !input.stream });
      } catch (error) {
        // Roll the id back and release the mic we just opened — a failed add
        // must not leave a phantom id in the published list or a hot track.
        sourceIdsRef.current = sourceIdsRef.current.filter((existing) => existing !== id);
        sourceIdToStreamRef.current.delete(id);
        if (!input.stream) stream.getTracks().forEach((t) => t.stop());
        throw error;
      }
      sourceIdToStreamRef.current.set(id, stream);

      // A mic joining a MUTED session must arrive muted. Otherwise plugging one
      // in silently un-mutes part of the room — the mute state the clinician
      // set would only apply to the sources that happened to be present when
      // they pressed it — and the eventual unmute() would land on a track that
      // was already live.
      if (store.isMuted) {
        for (const track of stream.getAudioTracks?.() ?? []) {
          track.enabled = false;
        }
      }

      // Registered for teardown as well: the mixer releases SDK-owned sources
      // on removal/dispose, but the `sourceStreamsRef` contract is that it
      // holds EVERY stream the session uses, so a mixer that throws
      // mid-teardown still leaves nothing hot that the SDK owns.
      sourceStreamsRef.current = [...sourceStreamsRef.current, stream];
      watchSourceForLoss(stream);
      publishSourceIds();

      logger?.info('Capture source added to the live mix', {
        operation: 'addSource',
        component: 'useArcaAudio',
        attributes: { id, gain, fromStream: !!input.stream, sourceCount: sourceIdsRef.current.length },
      });
      return id;
    },
    [store, getLogger, nextSourceId, publishSourceIds, watchSourceForLoss],
  );

  /**
   * Drop a capture source from the live mix (TASK-609). For an SDK-owned
   * source (opened from a `deviceId`) the mixer stops its tracks, releasing
   * the microphone immediately; a caller-owned stream (`addSource({ stream })`,
   * `sourceStreams`) is unwired but left LIVE for its owner to stop
   * (TASK-612 OD-1a).
   *
   * Removing the LAST source is refused: an empty mix is not a capture state,
   * it is silence on an open socket — indistinguishable, downstream, from the
   * failure modes this ticket exists to eliminate. Use `stop()`.
   */
  const removeSource = useCallback(
    (id: string): void => {
      const mixer = mixerRef.current;
      if (!mixer) throw new Error('useArcaAudio.removeSource: this capture session has no mixer.');
      if (!sourceIdsRef.current.includes(id)) throw new Error(`useArcaAudio.removeSource: unknown source id "${id}".`);
      if (sourceIdsRef.current.length <= 1) {
        throw new Error('useArcaAudio.removeSource: refusing to remove the last capture source — call stop() to end capture instead.');
      }

      mixer.removeSource(id);
      sourceIdsRef.current = sourceIdsRef.current.filter((existing) => existing !== id);

      // Drop the stream from the teardown/mute set too (TASK-611) — otherwise
      // it lingers in `sourceStreamsRef` for the rest of the session: dead to
      // the mixer but still walked by `applyEnabledToAllSources` and
      // `stopAudio`'s teardown loop. `sourceStreamsRef` is positional with no
      // id of its own, so the lookup goes through `sourceIdToStreamRef`.
      const removedStream = sourceIdToStreamRef.current.get(id);
      sourceIdToStreamRef.current.delete(id);
      if (removedStream) {
        sourceStreamsRef.current = sourceStreamsRef.current.filter((existing) => existing !== removedStream);
      }

      publishSourceIds();

      getLogger()?.info('Capture source removed from the live mix', {
        operation: 'removeSource',
        component: 'useArcaAudio',
        attributes: { id, sourceCount: sourceIdsRef.current.length },
      });
    },
    [getLogger, publishSourceIds],
  );

  /**
   * Set a source's linear gain in the live mix (`1.0` = unity) — the balance
   * control for "the room mic is much quieter than the headset" (TASK-609).
   * Independent of the mixer's own `1/√N` master normalization.
   */
  const setSourceGain = useCallback((id: string, gain: number): void => {
    const mixer = mixerRef.current;
    if (!mixer) throw new Error('useArcaAudio.setSourceGain: this capture session has no mixer.');
    if (!Number.isFinite(gain) || gain < 0) throw new Error(`useArcaAudio.setSourceGain: gain must be a finite number >= 0 (got ${gain}).`);
    mixer.setSourceGain(id, gain);
  }, []);

  /**
   * Start capture from the user's persisted preferences.
   *
   * Derives {@link AudioStartOptions} from `store.preferences` (already populated
   * by PersonalizationManager / useArcaConfig — no new config plumbing):
   *   - `language`            ← `preferences.language`
   *   - STT provider          ← `preferences.workflowMode` ('remote' → backend,
   *                             else local). For the backend workflow the
   *                             admin-assigned `preferences.remoteConfig.pipelineId`
   *                             is forwarded; local leaves `pipelineId` undefined
   *                             so the SDK uses the local provider.
   *   - `deviceId` / `secondaryDeviceId` / `dualCaptureEnabled`
   *                           ← `preferences.custom` (the existing extensible bag).
   */
  const startFromPreferences = useCallback(async (): Promise<void> => {
    const prefs = store.preferences ?? {};
    const isRemote = prefs.workflowMode === 'remote';
    const custom = (prefs.custom ?? {}) as Record<string, unknown>;

    const options: AudioStartOptions = {
      language: prefs.language,
      pipelineId: isRemote ? prefs.remoteConfig?.pipelineId : undefined,
      deviceId: typeof custom.deviceId === 'string' ? custom.deviceId : undefined,
      secondaryDeviceId: typeof custom.secondaryDeviceId === 'string' ? custom.secondaryDeviceId : undefined,
      dualCaptureEnabled: custom.dualCaptureEnabled === true,
    };

    getLogger()?.debug('Starting audio from preferences', {
      operation: 'startFromPreferences',
      component: 'useArcaAudio',
      attributes: { workflowMode: prefs.workflowMode, language: options.language, hasPipeline: !!options.pipelineId },
    });

    return startAudio(options);
  }, [store, getLogger, startAudio]);

  /**
   * The in-flight `stopAudio()` promise, or `null`.
   *
   * Two facts make this load-bearing:
   *
   *  1. The compat layer drives ONE audio graph through TWO hooks
   *     (`useAudioCapture.stopRecording` and
   *     `useArcaSpeechToText.stopTranscription`), and both guard on a
   *     RENDER-TIME `isCapturing` snapshot. A consumer that stops both in the
   *     same tick therefore lands in here twice with the first still running.
   *  2. Now that the graph is torn down BEFORE the drain is awaited, that
   *     second call would find nothing left to release and go straight to a
   *     SECOND `pluginManager.destroy()` — i.e. a second drain wait against an
   *     already-closed transport, re-adding exactly the latency this change
   *     removes.
   *
   * Handing the duplicate caller the SAME promise makes it free. The ref is
   * cleared on settle, so a genuinely later stop (host unmount after a
   * completed stop) still runs its own pass.
   */
  const stopInFlightRef = useRef<Promise<void> | null>(null);

  const stopAudio = useCallback((): Promise<void> => {
    if (stopInFlightRef.current) return stopInFlightRef.current;

    const { pluginManager, consultation } = store;
    const logger = getLogger();
    if (!pluginManager) return Promise.resolve();

    logger?.debug('Stopping audio capture', {
      operation: 'stopAudio',
      component: 'useArcaAudio',
      sdk: { consultationId: consultation?.id },
    });

    const run = async (): Promise<void> => {
      // ---------------------------------------------------------------------
      // 1. Flush the dual-capture recorder.
      //
      // This MUST stay ahead of the track stops in step 2:
      // `DualStreamRecorder.stop()` calls `MediaRecorder.stop()` and waits for
      // that recorder's `onstop`. Once a recorder's stream has gone inactive
      // the call throws `InvalidStateError` and the promise it is racing never
      // settles — `stopAudio` would hang forever instead of merely losing the
      // blobs. It is a local encoder flush (milliseconds) on the LOCAL
      // workflow only, so it never puts the transport drain on this path.
      // ---------------------------------------------------------------------
      const recorder = dualRecorderRef.current;
      if (recorder?.isRecording) {
        try {
          const result = await recorder.stop();
          onDualCaptureRef.current?.(result);
        } catch (error) {
          logger?.warn('Dual capture stop failed', {
            operation: 'stopAudio',
            component: 'useArcaAudio',
            error: error as Error,
          });
        }
      }
      dualRecorderRef.current = null;
      onDualCaptureRef.current = undefined;

      // ---------------------------------------------------------------------
      // 2. USER-VISIBLE TEARDOWN — deliberately BEFORE the transport drain
      //    (TASK-597 finding D2).
      //
      // This whole block is synchronous, so by the time `stopAudio` yields to
      // its first `await` the microphone is released, the browser's recording
      // indicator is out, and `isCapturing` is already false. Before 597 every
      // line below sat AFTER `await pluginManager.destroy()`, which blocks on
      // the streaming STT drain — so a click on Stop left the mic hot and the
      // UI stuck in "recording" for the whole drain window.
      //
      // Nothing here touches the transport: the drain in step 3 still gets its
      // full window, and the audio it is draining was already sent.
      // ---------------------------------------------------------------------

      // Tear down the input-level meter (before the stream/context are stopped).
      if (levelMeterRef.current) {
        clearInterval(levelMeterRef.current.timer);
        try {
          levelMeterRef.current.source.disconnect();
          levelMeterRef.current.analyser.disconnect();
        } catch {
          // disconnect after context close can throw on some platforms — ignore.
        }
        levelMeterRef.current = null;
      }

      // Stop the uplink-bitrate poll (the store reset below zeroes the value).
      if (uplinkTimerRef.current) {
        clearInterval(uplinkTimerRef.current);
        uplinkTimerRef.current = null;
      }

      // Detach the device-loss watchers BEFORE the tracks are stopped, so the
      // teardown's own `track.stop()` cannot fire an `ended` handler and post a
      // "device disconnected" error for a perfectly normal Stop (TASK-609).
      releaseSourceWatchers();
      sourceIdsRef.current = [];
      sourceIdToStreamRef.current.clear();
      store.setAudioSourceIds?.([]);

      // Tear down the N-source mixer (its dispose() removes every source —
      // stopping the tracks of SDK-owned sources only, per each source's
      // `stopTracksOnRemove` (TASK-612) — and stops per-source level
      // monitoring, so no analyser tap or sampling timer can outlive the
      // capture session).
      if (mixerRef.current) {
        mixerRef.current.dispose();
        mixerRef.current = null;
      }
      // Then stop every OTHER SDK-owned source stream of this capture
      // session — see the `sourceStreamsRef` contract above. Belt-and-braces
      // with the mixer dispose (a mixer that threw while adopting sources
      // would otherwise leave the rest live), and the only release path for a
      // source when there is no mixer at all. Caller-owned streams are
      // skipped — the SDK unwires but never stops them (TASK-612 OD-1a).
      // `activeStream` is excluded because the block below releases it —
      // releasing the microphone EXACTLY once is an asserted contract
      // (`useArca.audio-unification.test.ts`).
      {
        const activeTracks = new Set(store.activeStream?.getTracks?.() ?? []);
        for (const source of sourceStreamsRef.current) {
          if (callerOwnedStreamsRef.current.has(source)) continue;
          source.getTracks().forEach((t) => {
            if (!activeTracks.has(t)) t.stop();
          });
        }
        sourceStreamsRef.current = [];
      }

      const { activeStream } = store;
      if (activeStream) {
        // The primary source may be caller-owned (injected `sourceStreams[0]`)
        // — then its tracks stay LIVE; only the session's claim on it ends.
        if (!callerOwnedStreamsRef.current.has(activeStream)) {
          activeStream.getTracks().forEach((t) => t.stop());
        }
        store.setActiveStream(null);
      }
      store.setActiveAudioContext(null);

      store.setIsCapturing(false);
      store.setIsSpeaking(false);
      store.setAudioLevel(0);
      // No capture session ⇒ no per-source signal. Cleared in the SAME
      // synchronous block as the mic release so a consumer can never read a
      // stale "mic 2 is speaking" level while the transport drains.
      store.setAudioSourceLevels?.([]);
      // …and no audio-signal verdict either (TASK-612 Lane D) — a 'silent'
      // latched mid-session must not outlive the session that earned it.
      store.setAudioSignalState?.('ok');
      store.setCurrentTranscript('');

      // ---------------------------------------------------------------------
      // 3. ONLY NOW await the transport.
      //
      // The plugin callbacks installed by `startAudio` are still wired, so a
      // tail final emitted by the server during the drain still runs through
      // `onTranscription` and still lands in `transcriptSegments`. Not losing
      // that last caption is the entire reason the drain exists — the mic
      // being off is orthogonal to it.
      // ---------------------------------------------------------------------
      await pluginManager.destroy();
      pluginManager.clearRuntimeOptions?.();

      // Connection-shaped signals are reset AFTER the drain on purpose: the
      // transport emits its own disconnect/reconnect callbacks while
      // destroy() runs, and those would overwrite a reset done before it.
      // Session ended; clear the audio-drop signal (start/stop are the
      // ONLY reset points — the latch deliberately survives reconnect).
      store.resetAudioDropped();
      // Session ended; clear the streaming STT connection/pipeline signal.
      store.setSttConnectionState('connected');
      store.setActivePipeline(null);
      serverPipelineRef.current = null;

      logger?.info('Audio capture stopped', {
        operation: 'stopAudio',
        component: 'useArcaAudio',
        success: true,
      });
    };

    const inFlight = run().finally(() => {
      if (stopInFlightRef.current === inFlight) stopInFlightRef.current = null;
    });
    stopInFlightRef.current = inFlight;
    return inFlight;
  }, [store, getLogger, releaseSourceWatchers]);

  /**
   * Switch the live streaming session's ASR engine (TASK-586 Lane D —
   * generalized from the TASK-567 R4 one-way `switchToFallback`).
   *
   * Primary path: POST the switch route via the streaming session manager
   * (`target: 'fallback'` hits the native or compat route depending on how
   * the manager was configured; `target: 'primary'` requires compat mode —
   * see `StreamingSessionManager.switchProvider`). The backend swaps the ASR
   * engine while the WebSocket/session survive, and the client learns the new
   * pipeline from the `provider_switched` status frame (which updates
   * `activePipeline` / `sttConnectionState` — see the `onProviderSwitched`
   * callback above, which now un-latches on an explicit primary frame too).
   *
   * Degraded path (fallback direction only): on a backend without the
   * in-place route (404), if the caller supplies `opts.fallbackPipelineId`
   * the session is rebuilt on it (destroy/recreate) — a reconnect-shaped
   * fallback surfaced honestly as `reconnecting`. Symmetric rebuild support
   * for the primary direction via `opts.primaryPipelineId`. Without an id to
   * rebuild on, the NOT_FOUND error propagates.
   *
   * `opts.useCompatEndpoint` (compat layer only) opts the session manager
   * into the `/api/stt/switch` shim route for this call via
   * `sessionManager.setCompatSwitchEnabled()` — native SDK consumers never
   * set this, so their `switchToFallback()` keeps hitting the native route.
   */
  const switchProvider = useCallback(
    async (
      target: 'primary' | 'fallback',
      opts?: { fallbackPipelineId?: string; primaryPipelineId?: string; useCompatEndpoint?: boolean },
    ): Promise<void> => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) throw new Error('SDK not initialized');

      const sessionManager = pluginManager.getTranscriptionPipeline?.()?.getStreamingSessionManager?.() as
        StreamingSessionManagerLike | null | undefined;
      const sessionId = sessionManager?.getSessionId?.() ?? null;
      if (!sessionManager || !sessionId) {
        throw new Error(`No active streaming session to switch to ${target}`);
      }

      if (opts?.useCompatEndpoint) {
        sessionManager.setCompatSwitchEnabled?.(true);
      }

      logger?.info('Switching streaming session provider', {
        operation: 'switchProvider',
        component: 'useArcaAudio',
        attributes: { sessionId, target },
      });

      try {
        if (target === 'fallback') {
          await sessionManager.switchToFallback?.();
        } else {
          await sessionManager.switchProvider?.('primary');
        }
        // Success is confirmed asynchronously by the backend `provider_switched`
        // status frame; nothing to set optimistically here.
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const rebuildPipelineId = target === 'fallback' ? opts?.fallbackPipelineId : opts?.primaryPipelineId;
        if (code === 'NOT_FOUND' && rebuildPipelineId) {
          logger?.warn('Seamless switch unsupported by backend — rebuilding on the target pipeline', {
            operation: 'switchProvider',
            component: 'useArcaAudio',
            attributes: { target, rebuildPipelineId },
          });
          store.setSttConnectionState('reconnecting');
          await stopAudio();
          await startAudio({ pipelineId: rebuildPipelineId, language: store.audioLanguage });
          store.setSttConnectionState(target === 'fallback' ? 'switched_fallback' : 'connected');
          store.setActivePipeline({ id: rebuildPipelineId, name: rebuildPipelineId, isFallback: target === 'fallback' });
          return;
        }
        store.setSttConnectionState('error');
        throw err;
      }
    },
    [store, getLogger, stopAudio, startAudio],
  );

  /**
   * Switch the live streaming session to the tenant fallback pipeline (R4).
   * Alias for `switchProvider('fallback', { fallbackPipelineId })` — kept for
   * native callers (backward compatibility; zero behavior change).
   */
  const switchToFallback = useCallback(
    (fallbackPipelineId?: string): Promise<void> => switchProvider('fallback', { fallbackPipelineId }),
    [switchProvider],
  );

  /**
   * Apply an `enabled` state to the audio tracks of EVERY source the session
   * owns (TASK-609).
   *
   * Mute used to act on `store.activeStream` alone — the FIRST resolved source.
   * With N mixed microphones (TASK-597) or a mic added at runtime, that muted
   * microphone 1 and left the rest of the room live on the socket while the UI
   * said "muted": a privacy failure in a consultation, not a cosmetic one.
   *
   * `sourceStreamsRef` is the authoritative list (see its REF CONTRACT), but
   * `activeStream` is unioned in so a stream the ref never saw is still covered,
   * and the union is DE-DUPLICATED by track identity because `activeStream` is
   * normally `sourceStreams[0]`.
   *
   * Deliberately still `track.enabled`, not `AudioMixer.muteSource`: a
   * single-source session has no mixer by design, which is the most common
   * case of all.
   */
  const applyEnabledToAllSources = useCallback(
    (enabled: boolean) => {
      const seen = new Set<MediaStreamTrack>();
      for (const stream of [...sourceStreamsRef.current, ...(store.activeStream ? [store.activeStream] : [])]) {
        for (const track of stream.getAudioTracks?.() ?? []) {
          if (seen.has(track)) continue;
          seen.add(track);
          track.enabled = enabled;
        }
      }
      return seen.size;
    },
    [store],
  );

  const muteAudio = useCallback(() => {
    const logger = getLogger();
    store.setIsMuted(true);
    isMutedRef.current = true; // live channel for the watchdog tick (TASK-612)
    const trackCount = applyEnabledToAllSources(false);
    logger?.debug('Muting audio', { operation: 'muteAudio', component: 'useArcaAudio', attributes: { trackCount } });
  }, [store, getLogger, applyEnabledToAllSources]);

  const unmuteAudio = useCallback(() => {
    const logger = getLogger();
    store.setIsMuted(false);
    isMutedRef.current = false; // live channel for the watchdog tick (TASK-612)
    const trackCount = applyEnabledToAllSources(true);
    logger?.debug('Unmuting audio', { operation: 'unmuteAudio', component: 'useArcaAudio', attributes: { trackCount } });
  }, [store, getLogger, applyEnabledToAllSources]);

  const toggleNoiseFilter = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const newState = enabled ?? !pluginManager.getStates().noiseFilter.isActive;

      logger?.debug('Toggling noise filter', {
        operation: 'toggleNoiseFilter',
        component: 'useArcaAudio',
        attributes: { newState },
      });

      await pluginManager.setEnabled('noiseFilter', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  /**
   * Toggle STT on/off.
   * ASR-L-01/HOOK-05: Exposes STT toggle through the unified hook.
   */
  const toggleSTT = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const currentStates = pluginManager.getStates();
      const newState = enabled ?? !currentStates.stt.isActive;

      logger?.debug('Toggling STT', {
        operation: 'toggleSTT',
        component: 'useArcaAudio',
        attributes: { newState },
      });

      await pluginManager.setEnabled('stt', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  /**
   * Toggle VAD on/off.
   * ASR-L-01/HOOK-05: Exposes VAD toggle through the unified hook.
   */
  const toggleVAD = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const currentStates = pluginManager.getStates();
      const newState = enabled ?? !currentStates.vad.isActive;

      logger?.debug('Toggling VAD', {
        operation: 'toggleVAD',
        component: 'useArcaAudio',
        attributes: { newState },
      });

      await pluginManager.setEnabled('vad', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  // ==========================================================================
  // Memoized Return
  // ==========================================================================

  return useMemo(
    () => ({
      isCapturing: store.isCapturing,
      isMuted: store.isMuted,
      level: store.audioLevel,
      isSpeaking: store.isSpeaking,
      currentTranscript: store.currentTranscript,
      transcriptSegments: store.transcriptSegments ?? [],
      language: store.audioLanguage ?? 'en',
      plugins: store.audioPlugins,
      error: store.audioError,
      // Surface the audio-drop signal so the vox consultation UI can
      // render a degraded-connection banner/badge. `droppedFrameCount` is the
      // per-session count; `audioLostThisSession` is the session-sticky latch.
      droppedFrameCount: store.audioDroppedFrameCount,
      audioLostThisSession: store.audioLostThisSession,
      // Live outbound uplink bitrate (bits/sec) over the last ~1s; 0 when not streaming.
      uplinkBitrate: store.audioUplinkBitrate,
      // PER-SOURCE input levels (0-100), index-aligned with the resolved
      // capture-source order (TASK-597 follow-up #2). `[]` = no per-source
      // signal (no session, or a runtime that cannot analyse) — consumers must
      // NOT infer attribution from an empty array. `level` above is unchanged:
      // it stays the single MIXED level every existing consumer reads.
      sourceLevels: store.audioSourceLevels ?? [],
      // Ids of the sources in the live mix (TASK-609), index-aligned with
      // `sourceLevels`. `[]` when there is no mixer — see `dynamicSources`.
      sourceIds: store.audioSourceIds ?? [],
      // Streaming STT connection health + active pipeline (TASK-567 Phase F).
      sttConnectionState: store.sttConnectionState,
      activePipeline: store.activePipeline,
      start: startAudio,
      startFromPreferences,
      // Runtime source management (TASK-609) — mid-session, session-preserving.
      addSource,
      removeSource,
      setSourceGain,
      stop: stopAudio,
      switchToFallback,
      switchProvider,
      mute: muteAudio,
      unmute: unmuteAudio,
      toggleNoiseFilter,
      toggleSTT,
      toggleVAD,
    }),
    [
      store.isCapturing,
      store.isMuted,
      store.audioLevel,
      store.isSpeaking,
      store.currentTranscript,
      store.transcriptSegments,
      store.audioLanguage,
      store.audioPlugins,
      store.audioError,
      store.audioDroppedFrameCount,
      store.audioLostThisSession,
      store.audioUplinkBitrate,
      store.audioSourceLevels,
      store.audioSourceIds,
      store.sttConnectionState,
      store.activePipeline,
      startAudio,
      startFromPreferences,
      addSource,
      removeSource,
      setSourceGain,
      stopAudio,
      switchToFallback,
      switchProvider,
      muteAudio,
      unmuteAudio,
      toggleNoiseFilter,
      toggleSTT,
      toggleVAD,
    ],
  );
}
