/**
 * @arcaai/vox - useArcaAudio Hook (REFACTOR-01)
 *
 * Focused hook for audio capture, muting, and plugin control.
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback, useRef } from 'react';
import { useAgenticStore } from '../store';
import type { ContextItem, TranscriptionResult } from '../types';
import type { TranscriptSegment, AudioStartOptions, DualCaptureResult, ProviderSwitchInfo } from '../types/audio';
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
  // start() and stop(): the 2-mic mixer (+ its secondary stream) for F3, and
  // the dual-capture recorder (+ its delivery callback) for F2.
  const mixerRef = useRef<AudioMixer | null>(null);
  const secondaryStreamRef = useRef<MediaStream | null>(null);
  // Self-contained input-level meter (TASK-543): the transcription pipeline
  // never surfaced an amplitude to the store, so meters/waveforms sat at 0.
  // An AnalyserNode on the capture graph (analysis-only — never routed to the
  // destination, so it adds no playback) samples RMS into `store.setAudioLevel`.
  const levelMeterRef = useRef<{ analyser: AnalyserNode; source: MediaStreamAudioSourceNode; timer: ReturnType<typeof setInterval> } | null>(null);
  // Live uplink-bitrate poller (TASK-543): samples the streaming STT transport's
  // cumulative bytes-sent once a second and publishes the delta*8 as bits/sec.
  const uplinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dualRecorderRef = useRef<DualStreamRecorder | null>(null);
  const onDualCaptureRef = useRef<((result: DualCaptureResult) => void) | undefined>(undefined);

  // ==========================================================================
  // Audio Actions
  // ==========================================================================

  const startAudio = useCallback(
    async (options?: AudioStartOptions): Promise<void> => {
      const { pluginManager, consultation } = store;
      const logger = getLogger();
      if (!pluginManager) throw new Error('SDK not initialized');

      // A new capture session starts with a clean audio-drop signal.
      // Reset BEFORE audio flows (the session-sticky latch clears on start/stop
      // only, so it survives reconnect but never leaks across capture sessions).
      store.resetAudioDropped();

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
        languageMode: options?.languageMode ?? store.sttLanguageMode,
        // Pre-start engine selection (TASK-586). Start-time only — the session
        // opens on the tenant-admin default provider when 'fallback'.
        startOn: options?.startOn,
      });

      const timer = logger?.startOperation('startAudio', {
        component: 'useArcaAudio',
        sdk: { consultationId: consultation?.id },
        attributes: { language: options?.language, pipelineId: options?.pipelineId },
      });

      try {
        // Get user media
        logger?.debug('Requesting microphone access', {
          operation: 'startAudio',
          component: 'useArcaAudio',
        });
        // Honor the selected primary microphone.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: options?.deviceId ? { deviceId: { exact: options.deviceId } } : true,
        });

        const ctxManager = AudioContextManager.getInstance({ sampleRate: 48000 });
        const audioContext = await ctxManager.acquire();

        store.setActiveStream(stream);
        store.setActiveAudioContext(audioContext);

        // Live input-level meter — best-effort + guarded so a runtime without
        // Web Audio analysis (or a test double) simply leaves the level at 0.
        try {
          if (typeof audioContext.createMediaStreamSource === 'function' && typeof audioContext.createAnalyser === 'function') {
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            const source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser); // analysis only — deliberately NOT connected to destination
            if (typeof analyser.getFloatTimeDomainData === 'function') {
              const buffer = new Float32Array(analyser.fftSize);
              const timer = setInterval(() => {
                try {
                  analyser.getFloatTimeDomainData(buffer);
                  let sumSquares = 0;
                  for (let i = 0; i < buffer.length; i += 1) sumSquares += buffer[i] * buffer[i];
                  const rms = Math.sqrt(sumSquares / buffer.length);
                  // Map speech-range RMS (~0..0.4) to a 0..100 meter with a gentle gain + ceiling.
                  store.setAudioLevel(Math.min(100, Math.round(rms * 250)));
                } catch {
                  // A transient analyser read error must never break capture.
                }
              }, 100);
              levelMeterRef.current = { analyser, source, timer };
            } else {
              source.disconnect();
            }
          }
        } catch (levelError) {
          logger?.debug('Live level meter unavailable', { operation: 'startAudio', component: 'useArcaAudio', error: levelError as Error });
        }

        // When a second mic is selected, mix both inputs
        // into one processed graph via @arcaai/room's AudioMixer, then feed the
        // mixed track to the noise-filter/VAD/STT pipeline.
        let track = stream.getAudioTracks()[0];
        if (options?.secondaryDeviceId) {
          const secondaryStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: options.secondaryDeviceId } },
          });
          secondaryStreamRef.current = secondaryStream;

          const mixer = new AudioMixer(audioContext);
          mixer.addSource('primary', stream);
          mixer.addSource('secondary', secondaryStream);
          mixerRef.current = mixer;

          const mixedTrack = mixer.getMixedTrack();
          if (mixedTrack) track = mixedTrack;

          logger?.debug('Mixed dual-microphone inputs', {
            operation: 'startAudio',
            component: 'useArcaAudio',
            attributes: { primaryDeviceId: options.deviceId, secondaryDeviceId: options.secondaryDeviceId },
          });
        }

        // Set up plugin callbacks
        pluginManager.setCallbacks({
          onTranscription: (result: TranscriptionResult) => {
            if (result.isFinal) {
              store.setCurrentTranscript('');

              const fallbackTime = Date.now();
              const segment: TranscriptSegment = {
                text: result.text,
                startTime: result.vadStreamStartSec ?? fallbackTime,
                endTime: result.vadStreamEndSec ?? fallbackTime,
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
          // BIDIRECTIONAL — primary→fallback OR fallback→primary). Prefer the
          // frame's explicit `active`/`isFallback` fields when present (a
          // backend that supports the compat bidirectional toggle reports
          // both directions); fall back to the pre-586 always-fallback
          // inference for a backend that only ever reports the one-way
          // primary→fallback switch, so this handler stays byte-compatible
          // with every pre-586 caller.
          onProviderSwitched: (info) => {
            const raw = info as ProviderSwitchInfo & { active?: 'primary' | 'fallback'; isFallback?: boolean };
            const isFallback = raw.isFallback !== undefined ? raw.isFallback : raw.active !== undefined ? raw.active === 'fallback' : true;
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
        // pipeline). `isFallback` reflects the pre-start `startOn` selection
        // (TASK-586) so the compat hook reads the right side from frame 1; a
        // later provider_switched still flips it mid-session.
        store.setSttConnectionState('connected');
        store.setActivePipeline(
          options?.pipelineId
            ? { id: options.pipelineId, name: options.pipelineId, isFallback: options?.startOn === 'fallback' }
            : null,
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
        timer?.error(error as Error);
        store.setAudioError(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

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

  const stopAudio = useCallback(async (): Promise<void> => {
    const { pluginManager, consultation } = store;
    const logger = getLogger();
    if (!pluginManager) return;

    logger?.debug('Stopping audio capture', {
      operation: 'stopAudio',
      component: 'useArcaAudio',
      sdk: { consultationId: consultation?.id },
    });

    // Flush the dual-capture recorder BEFORE tearing down
    // the pipeline (destroy ends the processed track), then deliver the blobs.
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

    await pluginManager.destroy();
    pluginManager.clearRuntimeOptions?.();

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

    // Tear down the 2-mic mixer (stops both source streams).
    if (mixerRef.current) {
      mixerRef.current.dispose();
      mixerRef.current = null;
    }
    secondaryStreamRef.current = null;

    const { activeStream } = store;
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      store.setActiveStream(null);
    }
    store.setActiveAudioContext(null);

    store.setIsCapturing(false);
    store.setIsSpeaking(false);
    store.setAudioLevel(0);
    store.setCurrentTranscript('');
    // Session ended; clear the audio-drop signal (start/stop are the
    // ONLY reset points — the latch deliberately survives reconnect).
    store.resetAudioDropped();
    // Session ended; clear the streaming STT connection/pipeline signal.
    store.setSttConnectionState('connected');
    store.setActivePipeline(null);

    logger?.info('Audio capture stopped', {
      operation: 'stopAudio',
      component: 'useArcaAudio',
      success: true,
    });
  }, [store, getLogger]);

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

  const muteAudio = useCallback(() => {
    const logger = getLogger();
    logger?.debug('Muting audio', { operation: 'muteAudio', component: 'useArcaAudio' });
    store.setIsMuted(true);
    const { activeStream } = store;
    if (activeStream) {
      activeStream.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
    }
  }, [store, getLogger]);

  const unmuteAudio = useCallback(() => {
    const logger = getLogger();
    logger?.debug('Unmuting audio', { operation: 'unmuteAudio', component: 'useArcaAudio' });
    store.setIsMuted(false);
    const { activeStream } = store;
    if (activeStream) {
      activeStream.getAudioTracks().forEach((t) => {
        t.enabled = true;
      });
    }
  }, [store, getLogger]);

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
      // Streaming STT connection health + active pipeline (TASK-567 Phase F).
      sttConnectionState: store.sttConnectionState,
      activePipeline: store.activePipeline,
      start: startAudio,
      startFromPreferences,
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
      store.sttConnectionState,
      store.activePipeline,
      startAudio,
      startFromPreferences,
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
