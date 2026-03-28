/**
 * @arcaai/room - useAudioLevel Hook
 *
 * Hook for monitoring audio levels in real-time.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioTrack } from '../core/AudioTrack.js';
import { TrackEvent } from '../events/TrackEvents.js';
import type { AudioLevelInfo } from '../types/index.js';

/**
 * Options for useAudioLevel hook.
 */
export interface UseAudioLevelOptions {
  /** Speaking threshold (0-1) */
  speakingThreshold?: number;
  /** Update interval in ms */
  updateInterval?: number;
  /** Smoothing factor (0-1, higher = smoother) */
  smoothingFactor?: number;
  /** Enable/disable monitoring */
  enabled?: boolean;
}

/**
 * Return value of useAudioLevel hook.
 */
export interface UseAudioLevelReturn {
  /** Current audio level (0-1) */
  level: number;
  /** Whether voice activity is detected */
  isSpeaking: boolean;
  /** Peak level since last reset */
  peak: number;
  /** Average level */
  average: number;
  /** Full audio level info */
  audioLevelInfo: AudioLevelInfo;
  /** Reset peak level */
  resetPeak: () => void;
}

/**
 * Default audio level info.
 */
const DEFAULT_AUDIO_LEVEL_INFO: AudioLevelInfo = {
  level: 0,
  isSpeaking: false,
  peak: 0,
  average: 0,
};

/**
 * Hook for monitoring audio levels in real-time.
 *
 * @example
 * ```tsx
 * function AudioMeter() {
 *   const { track } = useAudioTrack({ autoStart: true });
 *   const { level, isSpeaking, peak, resetPeak } = useAudioLevel(track);
 *
 *   return (
 *     <div>
 *       <div
 *         style={{
 *           width: `${level * 100}%`,
 *           height: 20,
 *           backgroundColor: isSpeaking ? 'green' : 'gray',
 *         }}
 *       />
 *       <div>Peak: {(peak * 100).toFixed(0)}%</div>
 *       <button onClick={resetPeak}>Reset Peak</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAudioLevel(track: AudioTrack | null, options: UseAudioLevelOptions = {}): UseAudioLevelReturn {
  const { enabled = true } = options;

  const [audioLevelInfo, setAudioLevelInfo] = useState<AudioLevelInfo>(DEFAULT_AUDIO_LEVEL_INFO);

  // Subscribe to audio level updates from track
  useEffect(() => {
    if (!track || !enabled) {
      setAudioLevelInfo(DEFAULT_AUDIO_LEVEL_INFO);
      return;
    }

    const handleAudioLevel = (info: AudioLevelInfo) => {
      setAudioLevelInfo(info);
    };

    track.on(TrackEvent.AudioLevelUpdate, handleAudioLevel);

    return () => {
      track.off(TrackEvent.AudioLevelUpdate, handleAudioLevel);
    };
  }, [track, enabled]);

  // Reset peak
  const resetPeak = useCallback(() => {
    track?.resetPeakLevel();
    setAudioLevelInfo((prev) => ({ ...prev, peak: 0 }));
  }, [track]);

  return {
    level: audioLevelInfo.level,
    isSpeaking: audioLevelInfo.isSpeaking,
    peak: audioLevelInfo.peak,
    average: audioLevelInfo.average,
    audioLevelInfo,
    resetPeak,
  };
}

/**
 * Hook for monitoring audio levels from a MediaStreamTrack directly.
 * Use this when you don't have an AudioTrack instance.
 *
 * @example
 * ```tsx
 * function DirectAudioMeter({ mediaStreamTrack }) {
 *   const { level, isSpeaking } = useMediaStreamAudioLevel(mediaStreamTrack);
 *
 *   return (
 *     <div style={{ width: `${level * 100}%`, height: 10, backgroundColor: 'blue' }} />
 *   );
 * }
 * ```
 */
export function useMediaStreamAudioLevel(mediaStreamTrack: MediaStreamTrack | null, options: UseAudioLevelOptions = {}): UseAudioLevelReturn {
  const { speakingThreshold = 0.01, updateInterval = 50, smoothingFactor = 0.8, enabled = true } = options;

  const [audioLevelInfo, setAudioLevelInfo] = useState<AudioLevelInfo>(DEFAULT_AUDIO_LEVEL_INFO);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const smoothedLevelRef = useRef(0);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!mediaStreamTrack || !enabled) {
      setAudioLevelInfo(DEFAULT_AUDIO_LEVEL_INFO);
      return;
    }

    // Create AudioContext and nodes
    try {
      audioContextRef.current = new AudioContext({ latencyHint: 'interactive' });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      analyserRef.current.smoothingTimeConstant = smoothingFactor;

      const stream = new MediaStream([mediaStreamTrack]);
      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyserRef.current);

      // Start monitoring
      const dataArray = new Float32Array(analyserRef.current.fftSize);

      intervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;

        analyserRef.current.getFloatTimeDomainData(dataArray);

        // Calculate RMS
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const sample = dataArray[i]!;
          const abs = Math.abs(sample);
          sum += sample * sample;
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sum / dataArray.length);

        // Smooth the level
        smoothedLevelRef.current = smoothingFactor * smoothedLevelRef.current + (1 - smoothingFactor) * rms;

        // Update peak
        if (peak > peakRef.current) {
          peakRef.current = peak;
        }

        const level = smoothedLevelRef.current;
        const isSpeaking = level > speakingThreshold;

        setAudioLevelInfo({
          level,
          isSpeaking,
          peak: peakRef.current,
          average: level,
        });
      }, updateInterval);
    } catch (error) {
      console.warn('Failed to set up audio level monitoring:', error);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      analyserRef.current = null;
    };
  }, [mediaStreamTrack, enabled, speakingThreshold, updateInterval, smoothingFactor]);

  // Reset peak
  const resetPeak = useCallback(() => {
    peakRef.current = 0;
    setAudioLevelInfo((prev) => ({ ...prev, peak: 0 }));
  }, []);

  return {
    level: audioLevelInfo.level,
    isSpeaking: audioLevelInfo.isSpeaking,
    peak: audioLevelInfo.peak,
    average: audioLevelInfo.average,
    audioLevelInfo,
    resetPeak,
  };
}
