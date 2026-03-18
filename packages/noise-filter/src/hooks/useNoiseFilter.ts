/**
 * @arcaai/noise-filter - useNoiseFilter Hook
 *
 * React hook for AI-powered noise cancellation with @arcaai/room integration.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { ProcessorEvent } from '@arcaai/room';
import type { AudioTrack, ProcessorDataPayload } from '@arcaai/room';

import { NoiseFilterProcessor } from '../processors/NoiseFilterProcessor.js';
import type {
  NoiseFilterOptions,
  NoiseFilterStats,
  NoiseCancellationLevel,
} from '../types/index.js';

/**
 * Options for useNoiseFilter hook.
 */
export interface UseNoiseFilterOptions extends NoiseFilterOptions {
  /** The audio track to process (from useAudioTrack) */
  track: AudioTrack | null;

  /** Whether to auto-attach when track is available */
  autoAttach?: boolean;

  /** Callback when stats are updated */
  onStatsUpdate?: (stats: NoiseFilterStats) => void;

  /** Callback when an error occurs */
  onError?: (error: Error) => void;
}

/**
 * Return value of useNoiseFilter hook.
 */
export interface UseNoiseFilterReturn {
  /** Whether the noise filter is currently active and processing */
  isActive: boolean;

  /** Whether the processor is attached to the track */
  isAttached: boolean;

  /** Whether noise cancellation is enabled */
  isEnabled: boolean;

  /** Current noise cancellation level */
  noiseLevel: NoiseCancellationLevel;

  /** Whether using fallback mode (ScriptProcessor or native) */
  isUsingFallback: boolean;

  /** Noise filter processing statistics */
  stats: NoiseFilterStats | null;

  /** Estimated noise reduction in decibels */
  noiseReductionDb: number;

  /** Voice Activity Detection probability (0-1) */
  vadProbability: number;

  /** The noise filter processor instance */
  processor: NoiseFilterProcessor | null;

  /** Error if any occurred */
  error: Error | null;

  /** Attach noise filter to the track */
  attach: () => Promise<void>;

  /** Detach noise filter from the track */
  detach: () => Promise<void>;

  /** Enable noise cancellation */
  enable: () => Promise<void>;

  /** Disable noise cancellation */
  disable: () => Promise<void>;

  /** Toggle noise cancellation on/off */
  toggle: (enabled?: boolean) => Promise<void>;

  /** Set the noise cancellation level */
  setLevel: (level: NoiseCancellationLevel) => Promise<void>;

  /** Update noise filter options */
  updateOptions: (options: Partial<NoiseFilterOptions>) => Promise<void>;
}

/**
 * React hook for AI-powered noise cancellation.
 *
 * Integrates with @arcaai/room to provide real-time noise cancellation.
 *
 * @example
 * ```tsx
 * import { useAudioTrack } from '@arcaai/room';
 * import { useNoiseFilter } from '@arcaai/noise-filter';
 *
 * function AudioRecorder() {
 *   const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
 *     noiseSuppression: false, // Disable native NS, we use RNNoise
 *     echoCancellation: true,
 *   });
 *
 *   const {
 *     isActive,
 *     isEnabled,
 *     noiseLevel,
 *     noiseReductionDb,
 *     setLevel,
 *     toggle,
 *   } = useNoiseFilter({
 *     track,
 *     noiseCancellation: true,
 *     noiseCancellationLevel: 'high',
 *     autoAttach: true,
 *     onStatsUpdate: (stats) => {
 *       console.log('Noise reduction:', stats.noiseReductionDb, 'dB');
 *     },
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <div>Noise Filter: {isEnabled ? 'ON' : 'OFF'}</div>
 *       <div>Level: {noiseLevel}</div>
 *       <div>Noise Reduction: {noiseReductionDb.toFixed(1)} dB</div>
 *       <button onClick={() => toggle()}>Toggle Noise Filter</button>
 *       <select
 *         value={noiseLevel}
 *         onChange={(e) => setLevel(e.target.value as NoiseCancellationLevel)}
 *       >
 *         <option value="low">Low</option>
 *         <option value="medium">Medium</option>
 *         <option value="high">High</option>
 *       </select>
 *     </div>
 *   );
 * }
 * ```
 */
export function useNoiseFilter(options: UseNoiseFilterOptions): UseNoiseFilterReturn {
  const {
    track,
    autoAttach = true,
    onStatsUpdate,
    onError,
    ...noiseFilterOptions
  } = options;

  // State
  const [isActive, setIsActive] = useState(false);
  const [isAttached, setIsAttached] = useState(false);
  const [isEnabled, setIsEnabled] = useState(noiseFilterOptions.noiseCancellation ?? true);
  const [noiseLevel, setNoiseLevelState] = useState<NoiseCancellationLevel>(
    noiseFilterOptions.noiseCancellationLevel ?? 'medium'
  );
  const [isUsingFallback, setIsUsingFallback] = useState(false);
  const [stats, setStats] = useState<NoiseFilterStats | null>(null);
  const [noiseReductionDb, setNoiseReductionDb] = useState(0);
  const [vadProbability, setVadProbability] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  // Refs
  const processorRef = useRef<NoiseFilterProcessor | null>(null);
  const trackRef = useRef<AudioTrack | null>(null);
  const mountedRef = useRef(true);

  // Store callbacks in refs to avoid re-creating processor
  const callbacksRef = useRef({
    onStatsUpdate,
    onError,
  });

  // Update callback refs
  useEffect(() => {
    callbacksRef.current = {
      onStatsUpdate,
      onError,
    };
  }, [onStatsUpdate, onError]);

  // Create processor instance
  useEffect(() => {
    mountedRef.current = true;

    if (!processorRef.current) {
      processorRef.current = new NoiseFilterProcessor(noiseFilterOptions);
    }

    return () => {
      mountedRef.current = false;
      // Clean up processor on unmount
      if (processorRef.current) {
        processorRef.current.destroy().catch(console.error);
        processorRef.current = null;
      }
    };
    // Only create processor once with initial options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle processor events
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor) return;

    const handleData = (payload: ProcessorDataPayload) => {
      if (!mountedRef.current) return;

      if (payload.type === 'noise-stats') {
        const statsData = payload.data as NoiseFilterStats;
        setStats(statsData);
        setIsActive(statsData.isActive);
        setNoiseReductionDb(statsData.noiseReductionDb);
        setVadProbability(statsData.vadProbability);
        callbacksRef.current.onStatsUpdate?.(statsData);
      }
    };

    const handleError = (payload: { error: Error }) => {
      if (mountedRef.current) {
        setError(payload.error);
        callbacksRef.current.onError?.(payload.error);
      }
    };

    const handleEnabled = () => {
      if (mountedRef.current) {
        setIsEnabled(true);
        setIsActive(true);
      }
    };

    const handleDisabled = () => {
      if (mountedRef.current) {
        setIsEnabled(false);
        setIsActive(false);
      }
    };

    processor.on(ProcessorEvent.Data, handleData);
    processor.on(ProcessorEvent.Error, handleError);
    processor.on(ProcessorEvent.Enabled, handleEnabled);
    processor.on(ProcessorEvent.Disabled, handleDisabled);

    return () => {
      processor.off(ProcessorEvent.Data, handleData);
      processor.off(ProcessorEvent.Error, handleError);
      processor.off(ProcessorEvent.Enabled, handleEnabled);
      processor.off(ProcessorEvent.Disabled, handleDisabled);
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
      setIsUsingFallback(processor.isUsingFallback());
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to attach noise filter');
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
      setIsActive(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to detach noise filter');
      setError(error);
      throw err;
    }
  }, []);

  // Enable noise cancellation
  const enable = useCallback(async () => {
    const processor = processorRef.current;
    if (processor) {
      await processor.enable();
      setIsEnabled(true);
      setIsActive(true);
    }
  }, []);

  // Disable noise cancellation
  const disable = useCallback(async () => {
    const processor = processorRef.current;
    if (processor) {
      await processor.disable();
      setIsEnabled(false);
      setIsActive(false);
    }
  }, []);

  // Toggle noise cancellation
  const toggle = useCallback(async (enabled?: boolean) => {
    const newState = enabled ?? !isEnabled;
    if (newState) {
      await enable();
    } else {
      await disable();
    }
  }, [isEnabled, enable, disable]);

  // Set noise level
  const setLevel = useCallback(async (level: NoiseCancellationLevel) => {
    const processor = processorRef.current;
    if (processor) {
      await processor.setNoiseLevel(level);
      setNoiseLevelState(level);
    }
  }, []);

  // Update options
  const updateOptions = useCallback(async (newOptions: Partial<NoiseFilterOptions>) => {
    const processor = processorRef.current;
    if (processor) {
      await processor.updateOptions(newOptions);
      if (newOptions.noiseCancellationLevel !== undefined) {
        setNoiseLevelState(newOptions.noiseCancellationLevel);
      }
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

  return {
    isActive,
    isAttached,
    isEnabled,
    noiseLevel,
    isUsingFallback,
    stats,
    noiseReductionDb,
    vadProbability,
    processor: processorRef.current,
    error,
    attach,
    detach,
    enable,
    disable,
    toggle,
    setLevel,
    updateOptions,
  };
}
