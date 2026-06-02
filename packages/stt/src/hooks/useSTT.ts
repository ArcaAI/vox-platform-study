/**
 * @arcaai/stt - useSTT Hook
 *
 * React hook for Speech-to-Text with @arcaai/room integration.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ProcessorEvent } from '@arcaai/room';
import type { AudioTrack, ProcessorDataPayload } from '@arcaai/room';

import { STTProcessor } from '../core/STTProcessor.js';
import type { STTOptions, STTStats, TranscriptionResult, ModelLoadProgress, STTProviderType, LanguageLocale } from '../types/index.js';

/**
 * Options for useSTT hook.
 */
export interface UseSTTOptions extends STTOptions {
  /** The audio track to process (from useAudioTrack) */
  track: AudioTrack | null;

  /** Whether to auto-attach when track is available */
  autoAttach?: boolean;

  /** Callback when a final transcription is received */
  onTranscription?: (result: TranscriptionResult) => void;

  /** Callback when a partial/interim transcription is received */
  onPartialTranscription?: (result: TranscriptionResult) => void;

  /** Callback when an error occurs */
  onError?: (error: Error) => void;

  /** Callback for model loading progress (local provider only) */
  onProgress?: (progress: ModelLoadProgress) => void;
}

/**
 * Return value of useSTT hook.
 */
export interface UseSTTReturn {
  /** Whether the STT processor is ready and attached */
  isReady: boolean;

  /** Whether currently processing audio */
  isProcessing: boolean;

  /** Whether the model is loading (local provider only) */
  isLoading: boolean;

  /** Current interim/partial transcription */
  currentTranscript: string;

  /** List of final transcriptions */
  finalTranscripts: TranscriptionResult[];

  /** Most recent final transcription */
  lastTranscription: TranscriptionResult | null;

  /** Model loading progress (local provider only) */
  loadProgress: ModelLoadProgress | null;

  /** STT processing statistics */
  stats: STTStats | null;

  /** The STT processor instance */
  processor: STTProcessor | null;

  /** Whether the processor is attached to the track */
  isAttached: boolean;

  /** Current provider type in use */
  providerType: STTProviderType;

  /** Current language locale */
  language: LanguageLocale;

  /** Error if any occurred */
  error: Error | null;

  /** Attach STT to the track */
  attach: () => Promise<void>;

  /** Detach STT from the track */
  detach: () => Promise<void>;

  /** Transcribe a specific audio segment directly */
  transcribeSegment: (audio: Float32Array) => Promise<TranscriptionResult>;

  /** Clear all transcriptions */
  clear: () => void;

  /** Set the language for transcription */
  setLanguage: (language: LanguageLocale) => Promise<void>;
}

/**
 * React hook for Speech-to-Text transcription.
 *
 * Integrates with @arcaai/room to provide real-time STT processing.
 *
 * @example
 * ```tsx
 * import { useAudioTrack } from '@arcaai/room';
 * import { useSTT } from '@arcaai/stt';
 *
 * function Transcriber() {
 *   const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
 *     noiseSuppression: true,
 *   });
 *
 *   const {
 *     isReady,
 *     currentTranscript,
 *     finalTranscripts,
 *     isProcessing,
 *   } = useSTT({
 *     track,
 *     sttSocket: 'wss://api.example.com/ws/stt',
 *     autoAttach: true,
 *     audio: { language: 'en-US' },
 *     features: { provider: 'remote' },
 *     onTranscription: (result) => {
 *       console.log('Final transcription:', result.text);
 *     },
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <div>Status: {isProcessing ? 'Processing...' : 'Idle'}</div>
 *       <div>Current: {currentTranscript}</div>
 *       <div>
 *         Final Transcripts:
 *         {finalTranscripts.map((t, i) => (
 *           <p key={i}>{t.text}</p>
 *         ))}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useSTT(options: UseSTTOptions): UseSTTReturn {
  const { track, autoAttach = true, onTranscription, onPartialTranscription, onError, onProgress, ...sttOptions } = options;

  // State
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [finalTranscripts, setFinalTranscripts] = useState<TranscriptionResult[]>([]);
  const [lastTranscription, setLastTranscription] = useState<TranscriptionResult | null>(null);
  const [loadProgress, setLoadProgress] = useState<ModelLoadProgress | null>(null);
  const [stats, setStats] = useState<STTStats | null>(null);
  const [isAttached, setIsAttached] = useState(false);
  const [providerType, setProviderType] = useState<STTProviderType>('remote');
  const [language, setLanguageState] = useState<LanguageLocale>(sttOptions.audio?.language ?? 'en-US');
  const [error, setError] = useState<Error | null>(null);

  // Refs
  const processorRef = useRef<STTProcessor | null>(null);
  const trackRef = useRef<AudioTrack | null>(null);
  const mountedRef = useRef(true);

  // Store callbacks in refs to avoid re-creating processor
  const callbacksRef = useRef({
    onTranscription,
    onPartialTranscription,
    onError,
    onProgress,
  });

  // Update callback refs
  useEffect(() => {
    callbacksRef.current = {
      onTranscription,
      onPartialTranscription,
      onError,
      onProgress,
    };
  }, [onTranscription, onPartialTranscription, onError, onProgress]);

  const configFingerprint = useMemo(
    () =>
      JSON.stringify({
        modelId: sttOptions.features?.modelId,
        language: sttOptions.audio?.language,
        provider: sttOptions.features?.provider,
        diarization: sttOptions.features?.diarization,
        codeSwitching: sttOptions.features?.codeSwitching,
        vadGate: sttOptions.features?.vadGate,
        returnTimestamps: sttOptions.features?.returnTimestamps,
        // TASK-329 P3: the Whisper task (transcribe|translate) is baked into the
        // pooled local provider at init, so switching it must rebuild the
        // processor — otherwise a translate request reuses a transcribe-warm one.
        task: sttOptions.features?.task,
        // TASK-304 Wave 3 hotfix: include the voice-profile identity in the
        // fingerprint so a late-arriving `activeVoiceProfile` (e.g. backend
        // preferences resolving after the user already mounted the panel)
        // triggers a clean processor reinit. Otherwise the diarizer keeps
        // running with `reservedSpeakerId = undefined` and the first
        // detected speaker is mis-labelled as `speaker-1`.
        voiceProfileId: sttOptions.voiceProfile?.id,
        voiceProfileReserved: sttOptions.voiceProfile?.reservedSpeakerId,
      }),
    [
      sttOptions.features?.modelId,
      sttOptions.features?.provider,
      sttOptions.features?.diarization,
      sttOptions.features?.codeSwitching,
      sttOptions.features?.vadGate,
      sttOptions.features?.returnTimestamps,
      sttOptions.features?.task,
      sttOptions.audio?.language,
      sttOptions.voiceProfile?.id,
      sttOptions.voiceProfile?.reservedSpeakerId,
    ],
  );

  // Ref to hold latest sttOptions for processor creation without stale closure
  const sttOptionsRef = useRef(sttOptions);
  useEffect(() => {
    sttOptionsRef.current = sttOptions;
  }, [sttOptions]);

  // Create/recreate processor when critical config changes
  useEffect(() => {
    mountedRef.current = true;

    const wasAttached = !!trackRef.current;
    const previousTrack = trackRef.current;

    if (processorRef.current) {
      const oldProcessor = processorRef.current;
      processorRef.current = null;
      oldProcessor.destroy().catch(console.error);
      setIsAttached(false);
      setIsReady(false);
    }

    const currentOptions = sttOptionsRef.current;
    processorRef.current = new STTProcessor({
      ...currentOptions,
      onModelProgress: (progress) => {
        if (mountedRef.current) {
          setLoadProgress(progress);
          setIsLoading(progress.status === 'downloading' || progress.status === 'loading');
          if (progress.status === 'ready') {
            setIsLoading(false);
          }
          callbacksRef.current.onProgress?.(progress);
        }
      },
    });

    setProviderType(processorRef.current.getProviderType());

    if (wasAttached && previousTrack) {
      previousTrack
        .setProcessor(processorRef.current)
        .then(() => {
          if (mountedRef.current) {
            setIsAttached(true);
            setIsReady(true);
          }
        })
        .catch((err) => {
          if (mountedRef.current) {
            const error = err instanceof Error ? err : new Error('Failed to re-attach STT after config change');
            setError(error);
            callbacksRef.current.onError?.(error);
          }
        });
    }

    return () => {
      mountedRef.current = false;
      if (processorRef.current) {
        const processor = processorRef.current;
        processor
          .destroy()
          .catch(console.error)
          .finally(() => {
            processor.releaseWarmResources().catch(console.error);
          });
        processorRef.current = null;
      }
    };
  }, [configFingerprint]);

  // Handle processor events — re-bind when processor is recreated
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor) return;

    const handleData = (payload: ProcessorDataPayload) => {
      if (!mountedRef.current) return;

      switch (payload.type) {
        case 'stt-transcription': {
          const result = payload.data as TranscriptionResult;
          setCurrentTranscript('');
          setLastTranscription(result);
          setFinalTranscripts((prev) => [...prev, result]);
          setIsProcessing(false);
          callbacksRef.current.onTranscription?.(result);
          break;
        }

        case 'stt-partial': {
          const result = payload.data as TranscriptionResult;
          setCurrentTranscript(result.text);
          setIsProcessing(true);
          callbacksRef.current.onPartialTranscription?.(result);
          break;
        }

        case 'stt-model-loaded': {
          setIsLoading(false);
          break;
        }

        case 'stt-stats': {
          setStats(payload.data as STTStats);
          break;
        }
      }
    };

    const handleError = (payload: { error: Error }) => {
      if (mountedRef.current) {
        setError(payload.error);
        callbacksRef.current.onError?.(payload.error);
      }
    };

    processor.on(ProcessorEvent.Data, handleData);
    processor.on(ProcessorEvent.Error, handleError);

    return () => {
      processor.off(ProcessorEvent.Data, handleData);
      processor.off(ProcessorEvent.Error, handleError);
    };
  }, [configFingerprint]);

  // Attach to track
  const attach = useCallback(async () => {
    const processor = processorRef.current;
    if (!processor || !track) {
      setError(new Error('No track or processor available'));
      return;
    }

    try {
      setError(null);
      await track.setProcessor(processor);
      trackRef.current = track;
      setIsAttached(true);
      setIsReady(true);
      setProviderType(processor.getProviderType());
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to attach STT');
      setError(error);
      callbacksRef.current.onError?.(error);
      throw err;
    }
  }, [track]);

  // Detach from track
  const detach = useCallback(async () => {
    if (!trackRef.current) return;

    try {
      await trackRef.current.stopProcessor();
      trackRef.current = null;
      setIsAttached(false);
      setIsReady(false);
      setIsProcessing(false);
      setCurrentTranscript('');
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to detach STT');
      setError(error);
      throw err;
    }
  }, []);

  // Transcribe a segment directly
  const transcribeSegment = useCallback(async (audio: Float32Array): Promise<TranscriptionResult> => {
    const processor = processorRef.current;
    if (!processor) {
      throw new Error('Processor not available');
    }

    setIsProcessing(true);
    try {
      const result = await processor.transcribeSegment(audio);
      if (mountedRef.current) {
        setLastTranscription(result);
        setFinalTranscripts((prev) => [...prev, result]);
        setIsProcessing(false);
      }
      return result;
    } catch (err) {
      if (mountedRef.current) {
        setIsProcessing(false);
        const error = err instanceof Error ? err : new Error('Transcription failed');
        setError(error);
        callbacksRef.current.onError?.(error);
      }
      throw err;
    }
  }, []);

  // Clear transcriptions
  const clear = useCallback(() => {
    setCurrentTranscript('');
    setFinalTranscripts([]);
    setLastTranscription(null);
    setError(null);
  }, []);

  // Set language
  const setLanguage = useCallback(async (newLanguage: LanguageLocale) => {
    const processor = processorRef.current;
    if (processor) {
      await processor.setLanguage(newLanguage);
    }
    setLanguageState(newLanguage);
  }, []);

  // Auto-attach when track becomes available
  useEffect(() => {
    if (autoAttach && track && !isAttached) {
      attach().catch(console.error);
    }

    // Detach when track is removed
    if (!track && isAttached) {
      detach().catch(console.error);
    }
  }, [track, autoAttach, isAttached, attach, detach]);

  return {
    isReady,
    isProcessing,
    isLoading,
    currentTranscript,
    finalTranscripts,
    lastTranscription,
    loadProgress,
    stats,
    processor: processorRef.current,
    isAttached,
    providerType,
    language,
    error,
    attach,
    detach,
    transcribeSegment,
    clear,
    setLanguage,
  };
}
