/**
 * @arcaai/room - useAudioLevel Hook
 *
 * Hook for monitoring audio levels in real-time.
 *
 * Multiple consumers of `useAudioLevel(track)` for the same {@link AudioTrack}
 * share a **single** internally-managed {@link AnalyserNode}, ref-counted via
 * a module-scoped {@link WeakMap}. The analyser is torn down (interval
 * cleared, source disconnected) only when the last consumer unmounts (W2-4).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioTrack } from '../core/AudioTrack.js';
import { TrackEvent } from '../events/TrackEvents.js';
import type { AudioLevelInfo } from '../types/index.js';
import { calculateRMSLevel, calculatePeakLevel, detectVoiceActivity } from '../utils/audioUtils.js';

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

// ===========================================================================
// W2-4 — shared analyser ref-counted per AudioTrack
// ===========================================================================

/**
 * Per-track shared monitoring state. The same record is reused by every
 * `useAudioLevel(track)` consumer subscribing to the same track instance —
 * including the `setInterval` that drives the analyser sampling and the
 * `Set<listener>` of subscribed React state setters.
 */
interface SharedTrackMonitor {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode | null;
  intervalId: ReturnType<typeof setInterval> | null;
  dataArray: Float32Array;
  refCount: number;
  smoothedLevel: number;
  peakLevel: number;
  listeners: Set<(info: AudioLevelInfo) => void>;
}

/**
 * Module-scoped registry keyed by AudioTrack. WeakMap so unreachable tracks
 * don't pin their monitor record.
 */
const sharedTrackMonitors = new WeakMap<AudioTrack, SharedTrackMonitor>();

const DEFAULT_SPEAKING_THRESHOLD = 0.01;
const DEFAULT_UPDATE_INTERVAL_MS = 50;
const DEFAULT_SMOOTHING_FACTOR = 0.8;

/**
 * Acquire the shared monitor for a track (creating it if necessary), register
 * the listener, and return a release function that decrements the ref-count
 * and tears down the monitor when it reaches zero.
 *
 * Returns a no-op release function when the track has no available
 * `AudioContext` or source `MediaStreamTrack` — in that case there is
 * nothing to attach to.
 */
function acquireSharedMonitor(
  track: AudioTrack,
  options: { speakingThreshold: number; updateInterval: number; smoothingFactor: number },
  listener: (info: AudioLevelInfo) => void,
): () => void {
  const ctx = track.getAudioContext();
  const sourceTrack = track.sourceMediaStreamTrack;

  if (!ctx || !sourceTrack) {
    return () => {
      /* nothing to release */
    };
  }

  let shared = sharedTrackMonitors.get(track);

  if (!shared) {
    let analyser: AnalyserNode;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = options.smoothingFactor;
      const stream = new MediaStream([sourceTrack]);
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (error) {
      console.warn('[useAudioLevel] Failed to construct shared analyser:', error);
      return () => {
        /* nothing to release */
      };
    }

    const dataArray = new Float32Array(analyser.fftSize);

    const newShared: SharedTrackMonitor = {
      analyser,
      source,
      intervalId: null,
      dataArray,
      refCount: 0,
      smoothedLevel: 0,
      peakLevel: 0,
      listeners: new Set(),
    };

    newShared.intervalId = setInterval(() => {
      const local = newShared;
      try {
        local.analyser.getFloatTimeDomainData(local.dataArray as Float32Array<ArrayBuffer>);
      } catch {
        // analyser disconnected mid-tick; bail.
        return;
      }
      const rms = calculateRMSLevel(local.dataArray);
      const peak = calculatePeakLevel(local.dataArray);
      local.smoothedLevel = options.smoothingFactor * local.smoothedLevel + (1 - options.smoothingFactor) * rms;
      if (peak > local.peakLevel) local.peakLevel = peak;

      const info: AudioLevelInfo = {
        level: local.smoothedLevel,
        isSpeaking: detectVoiceActivity(local.smoothedLevel, options.speakingThreshold),
        peak: local.peakLevel,
        average: local.smoothedLevel,
      };

      for (const l of local.listeners) {
        l(info);
      }
    }, options.updateInterval);

    sharedTrackMonitors.set(track, newShared);
    shared = newShared;
  }

  shared.listeners.add(listener);
  shared.refCount++;

  return () => {
    const monitor = sharedTrackMonitors.get(track);
    if (!monitor) return;
    monitor.listeners.delete(listener);
    monitor.refCount--;
    if (monitor.refCount > 0) return;

    // Last consumer — tear down.
    if (monitor.intervalId !== null) {
      clearInterval(monitor.intervalId);
      monitor.intervalId = null;
    }
    if (monitor.source) {
      try {
        monitor.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      monitor.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
    sharedTrackMonitors.delete(track);
  };
}

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
  const {
    enabled = true,
    speakingThreshold = DEFAULT_SPEAKING_THRESHOLD,
    updateInterval = DEFAULT_UPDATE_INTERVAL_MS,
    smoothingFactor = DEFAULT_SMOOTHING_FACTOR,
  } = options;

  const [audioLevelInfo, setAudioLevelInfo] = useState<AudioLevelInfo>(DEFAULT_AUDIO_LEVEL_INFO);

  // W2-4: subscribe to a per-track shared analyser. When the AudioTrack has
  // its own internal analyser monitor running (the `monitorAudioLevel: true`
  // default), we additionally listen to the track's `AudioLevelUpdate` event
  // so the UI receives readings even before the shared interval ticks. This
  // preserves backward compatibility with the prior behaviour while
  // satisfying the ref-counted analyser contract.
  useEffect(() => {
    if (!track || !enabled) {
      setAudioLevelInfo(DEFAULT_AUDIO_LEVEL_INFO);
      return;
    }

    const handleAudioLevel = (info: AudioLevelInfo) => {
      setAudioLevelInfo(info);
    };

    const releaseShared = acquireSharedMonitor(track, { speakingThreshold, updateInterval, smoothingFactor }, handleAudioLevel);

    track.on(TrackEvent.AudioLevelUpdate, handleAudioLevel);

    return () => {
      track.off(TrackEvent.AudioLevelUpdate, handleAudioLevel);
      releaseShared();
    };
  }, [track, enabled, speakingThreshold, updateInterval, smoothingFactor]);

  // Reset peak
  const resetPeak = useCallback(() => {
    track?.resetPeakLevel();
    if (track) {
      const monitor = sharedTrackMonitors.get(track);
      if (monitor) monitor.peakLevel = 0;
    }
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
