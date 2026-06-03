/**
 * @arcaai/vox - useArcaAudio Hook (REFACTOR-01)
 *
 * Focused hook for audio capture, muting, and plugin control.
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback, useRef } from 'react';
import { useAgenticStore } from '../store';
import type { ContextItem, TranscriptionResult } from '../types';
import type { TranscriptSegment, AudioStartOptions, DualCaptureResult } from '../types/audio';
import { CONTEXT_ENDPOINTS } from '../core/constants';
import type { ISDKLogger } from '../core/logger';
import { AudioContextManager, AudioMixer } from '@arcaai/room';
import { DualStreamRecorder } from '../core/DualStreamRecorder';

// Re-export the interface from useArca.ts
export type { UseArcaAudio } from './useArca';

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

  // TASK-331 doc-06 — capture-session resources that must survive between
  // start() and stop(): the 2-mic mixer (+ its secondary stream) for F3, and
  // the dual-capture recorder (+ its delivery callback) for F2.
  const mixerRef = useRef<AudioMixer | null>(null);
  const secondaryStreamRef = useRef<MediaStream | null>(null);
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

      if (options?.language) {
        store.setAudioLanguage(options.language);
      }

      // TASK-298 D-4 — forward per-capture options to the plugin manager
      // BEFORE initialize so the streaming transport can be built for the
      // STT stage when a `pipelineId` is provided.
      pluginManager.setRuntimeOptions?.({
        pipelineId: options?.pipelineId,
        consultationId: consultation?.id,
        language: options?.language,
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
        // TASK-331 doc-06 F3 — honor the selected primary microphone.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: options?.deviceId ? { deviceId: { exact: options.deviceId } } : true,
        });

        const ctxManager = AudioContextManager.getInstance({ sampleRate: 48000 });
        const audioContext = await ctxManager.acquire();

        store.setActiveStream(stream);
        store.setActiveAudioContext(audioContext);

        // TASK-331 doc-06 F3 — when a second mic is selected, mix both inputs
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
                speakerLabel: result.speakerId,
                confidence: result.confidence,
                language: result.language,
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
        });

        // Initialize plugins
        await pluginManager.initialize(track, audioContext);

        store.setIsCapturing(true);
        store.setAudioPlugins(pluginManager.getStates());
        store.setAudioError(null);

        // TASK-331 doc-06 F2 — dual capture (RAW + PROCESSED) for the LOCAL
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
   * TASK-331 doc-06 F3/Q5 — start capture from the user's persisted preferences.
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

    // TASK-331 doc-06 F2 — flush the dual-capture recorder BEFORE tearing down
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

    // TASK-331 doc-06 F3 — tear down the 2-mic mixer (stops both source streams).
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

    logger?.info('Audio capture stopped', {
      operation: 'stopAudio',
      component: 'useArcaAudio',
      success: true,
    });
  }, [store, getLogger]);

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
      start: startAudio,
      startFromPreferences,
      stop: stopAudio,
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
      startAudio,
      startFromPreferences,
      stopAudio,
      muteAudio,
      unmuteAudio,
      toggleNoiseFilter,
      toggleSTT,
      toggleVAD,
    ],
  );
}
