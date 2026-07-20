/**
 * @arcaai/vad - useVAD Hook
 *
 * React hook for Voice Activity Detection with @arcaai/room integration.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { ProcessorEvent } from '@arcaai/room';
import type { AudioTrack, ProcessorDataPayload } from '@arcaai/room';

import { VADProcessor } from '../processors/VADProcessor.js';
import type { VADOptions, VADStats, VADFramePayload } from '../types/index.js';

/**
 * Options for useVAD hook.
 */
export interface UseVADOptions extends VADOptions {
  /** The audio track to process (from useAudioTrack) */
  track: AudioTrack | null;

  /** Whether to auto-attach when track is available */
  autoAttach?: boolean;

  /** Callback when speech starts */
  onSpeechStart?: () => void;

  /** Callback when speech ends with the audio segment */
  onSpeechEnd?: (audio: Float32Array) => void;

  /** Callback when VAD detects a misfire (speech too short) */
  onVADMisfire?: () => void;

  /** Callback for each processed frame */
  onFrameProcessed?: (probabilities: { isSpeech: number; notSpeech: number }, frame: Float32Array) => void;
}

/**
 * Return value of useVAD hook.
 */
export interface UseVADReturn {
  /** Whether the VAD is currently active and processing */
  isActive: boolean;

  /** Whether speech is currently being detected */
  isSpeaking: boolean;

  /** Current speech probability (0-1) */
  speechProbability: number;

  /** Duration of current speech segment in milliseconds */
  currentSpeechDuration: number;

  /** VAD processing statistics */
  stats: VADStats | null;

  /** The VAD processor instance */
  processor: VADProcessor | null;

  /** Whether the processor is attached to the track */
  isAttached: boolean;

  /** Error if any occurred */
  error: Error | null;

  /** Attach VAD to the track */
  attach: () => Promise<void>;

  /** Detach VAD from the track */
  detach: () => Promise<void>;

  /** Pause VAD processing */
  pause: () => void;

  /** Resume VAD processing */
  resume: () => void;

  /** Reset VAD statistics */
  resetStats: () => void;

  /** Update VAD options */
  updateOptions: (options: Partial<VADOptions>) => Promise<void>;
}

/**
 * React hook for Voice Activity Detection.
 *
 * Integrates with @arcaai/room to provide real-time VAD processing.
 *
 * @example
 * ```tsx
 * import { useAudioTrack } from '@arcaai/room';
 * import { useVAD } from '@arcaai/vad';
 *
 * function VoiceRecorder() {
 *   const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
 *     noiseSuppression: true,
 *   });
 *
 *   const {
 *     isSpeaking,
 *     speechProbability,
 *     stats,
 *   } = useVAD({
 *     track,
 *     model: 'v5',
 *     positiveSpeechThreshold: 0.5,
 *     autoAttach: true,
 *     onSpeechEnd: (audio) => {
 *       console.log('Speech ended, got', audio.length, 'samples');
 *       // Send to transcription service
 *     },
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
 *       <div>Probability: {(speechProbability * 100).toFixed(1)}%</div>
 *       <div>Segments: {stats?.speechSegmentsDetected ?? 0}</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useVAD(options: UseVADOptions): UseVADReturn {
  const { track, autoAttach = true, onSpeechStart, onSpeechEnd, onVADMisfire, onFrameProcessed, ...vadOptions } = options;

  // State
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechProbability, setSpeechProbability] = useState(0);
  const [currentSpeechDuration, setCurrentSpeechDuration] = useState(0);
  const [stats, setStats] = useState<VADStats | null>(null);
  const [isAttached, setIsAttached] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Refs
  const processorRef = useRef<VADProcessor | null>(null);
  const trackRef = useRef<AudioTrack | null>(null);

  // Store callbacks in refs to avoid re-creating processor
  const callbacksRef = useRef({
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire,
    onFrameProcessed,
  });

  // Update callback refs
  useEffect(() => {
    callbacksRef.current = {
      onSpeechStart,
      onSpeechEnd,
      onVADMisfire,
      onFrameProcessed,
    };
  }, [onSpeechStart, onSpeechEnd, onVADMisfire, onFrameProcessed]);

  // Create processor instance
  useEffect(() => {
    if (!processorRef.current) {
      processorRef.current = new VADProcessor({
        ...vadOptions,
        onSpeechStart: () => {
          setIsSpeaking(true);
          callbacksRef.current.onSpeechStart?.();
        },
        onSpeechEnd: (audio) => {
          setIsSpeaking(false);
          setCurrentSpeechDuration(0);
          callbacksRef.current.onSpeechEnd?.(audio);
        },
        onVADMisfire: () => {
          setIsSpeaking(false);
          setCurrentSpeechDuration(0);
          callbacksRef.current.onVADMisfire?.();
        },
        onFrameProcessed: (probabilities, frame) => {
          setSpeechProbability(probabilities.isSpeech);
          callbacksRef.current.onFrameProcessed?.(probabilities, frame);
        },
      });
    }

    return () => {
      // Clean up processor on unmount
      if (processorRef.current) {
        processorRef.current.destroy().catch(console.error);
        processorRef.current = null;
      }
    };
    // Only create processor once with initial options
  }, []);

  // Handle processor events
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor) return;

    const handleData = (payload: ProcessorDataPayload) => {
      switch (payload.type) {
        case 'vad-stats':
          setStats(payload.data as VADStats);
          setIsActive((payload.data as VADStats).isActive);
          setIsSpeaking((payload.data as VADStats).isSpeaking);
          setSpeechProbability((payload.data as VADStats).speechProbability);
          setCurrentSpeechDuration((payload.data as VADStats).currentSpeechDuration);
          break;

        case 'vad-frame': {
          const framePayload = payload.data as VADFramePayload;
          setSpeechProbability(framePayload.probability);
          break;
        }

        case 'vad-speech-start': {
          setIsSpeaking(true);
          break;
        }

        case 'vad-speech-end': {
          setIsSpeaking(false);
          setCurrentSpeechDuration(0);
          break;
        }

        case 'vad-misfire': {
          setIsSpeaking(false);
          setCurrentSpeechDuration(0);
          break;
        }
      }
    };

    const handleError = (payload: { error: Error }) => {
      setError(payload.error);
    };

    processor.on(ProcessorEvent.Data, handleData);
    processor.on(ProcessorEvent.Error, handleError);

    return () => {
      processor.off(ProcessorEvent.Data, handleData);
      processor.off(ProcessorEvent.Error, handleError);
    };
  }, []);

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
      setIsActive(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to attach VAD'));
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
      setIsActive(false);
      setIsSpeaking(false);
      setSpeechProbability(0);
      setCurrentSpeechDuration(0);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to detach VAD'));
      throw err;
    }
  }, []);

  // Pause VAD
  const pause = useCallback(() => {
    processorRef.current?.pause();
    setIsActive(false);
  }, []);

  // Resume VAD
  const resume = useCallback(() => {
    processorRef.current?.start();
    setIsActive(true);
  }, []);

  // Reset stats
  const resetStats = useCallback(() => {
    processorRef.current?.resetStats();
  }, []);

  // Update options
  const updateOptions = useCallback(async (newOptions: Partial<VADOptions>) => {
    if (processorRef.current) {
      await processorRef.current.updateOptions(newOptions);
    }
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

  // Update speech duration periodically when speaking
  useEffect(() => {
    if (!isSpeaking) return;

    const interval = setInterval(() => {
      const processor = processorRef.current;
      if (processor) {
        const currentStats = processor.getStats();
        setCurrentSpeechDuration(currentStats.currentSpeechDuration);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isSpeaking]);

  return {
    isActive,
    isSpeaking,
    speechProbability,
    currentSpeechDuration,
    stats,
    processor: processorRef.current,
    isAttached,
    error,
    attach,
    detach,
    pause,
    resume,
    resetStats,
    updateOptions,
  };
}
