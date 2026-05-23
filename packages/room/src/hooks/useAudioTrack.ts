/**
 * @arcaai/room - useAudioTrack Hook
 *
 * Hook for creating and managing audio tracks.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { AudioTrack, type AudioTrackOptions } from '../core/AudioTrack.js';
import { TrackEvent } from '../events/TrackEvents.js';
import type { AudioCaptureOptions, AudioFeature, TrackState, RoomError } from '../types/index.js';
import { useRoomSafe } from '../components/RoomProvider.js';

/**
 * Options for useAudioTrack hook.
 */
export interface UseAudioTrackOptions extends AudioCaptureOptions {
  /** Whether to auto-start capturing on mount */
  autoStart?: boolean;
  /** Custom AudioContext to use (if not using RoomProvider) */
  audioContext?: AudioContext;
  /** Enable audio level monitoring */
  monitorAudioLevel?: boolean;
  /** Audio level update interval in ms */
  audioLevelInterval?: number;
}

/**
 * Return value of useAudioTrack hook.
 */
export interface UseAudioTrackReturn {
  /** The AudioTrack instance, or null if not initialized */
  track: AudioTrack | null;
  /** Whether the track is currently capturing */
  isCapturing: boolean;
  /** Current track state */
  state: TrackState | null;
  /** Error if any occurred */
  error: RoomError | null;
  /** Whether the track is muted */
  isMuted: boolean;
  /** Start capturing audio */
  startCapture: (options?: AudioCaptureOptions) => Promise<void>;
  /** Stop capturing audio */
  stopCapture: () => Promise<void>;
  /** Mute the track */
  mute: () => void;
  /** Unmute the track */
  unmute: () => void;
  /** Toggle mute state */
  toggleMute: () => void;
  /** Set a feature enabled/disabled */
  setFeature: (feature: AudioFeature, enabled: boolean) => Promise<void>;
  /** Restart the track with new options */
  restart: (options?: AudioCaptureOptions) => Promise<void>;
}

/**
 * Hook for creating and managing audio tracks.
 *
 * Can be used with or without RoomProvider. When used with RoomProvider,
 * it will use the room's AudioContext.
 *
 * @example
 * ```tsx
 * function AudioRecorder() {
 *   const {
 *     track,
 *     isCapturing,
 *     startCapture,
 *     stopCapture,
 *     toggleMute,
 *     isMuted,
 *   } = useAudioTrack({
 *     noiseSuppression: true,
 *     echoCancellation: true,
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <button onClick={toggleMute}>
 *         {isMuted ? 'Unmute' : 'Mute'}
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAudioTrack(options: UseAudioTrackOptions = {}): UseAudioTrackReturn {
  const roomContext = useRoomSafe();

  const [track, setTrack] = useState<AudioTrack | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [state, setState] = useState<TrackState | null>(null);
  const [error, setError] = useState<RoomError | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  // Store options in ref to avoid re-creating track on options change
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const trackRef = useRef<AudioTrack | null>(null);

  // Get AudioContext from room or from options
  const getAudioContext = useCallback((): AudioContext | undefined => {
    if (options.audioContext) {
      return options.audioContext;
    }
    if (roomContext?.audioContext) {
      return roomContext.audioContext;
    }
    return undefined;
  }, [options.audioContext, roomContext?.audioContext]);

  // Start capturing
  const startCapture = useCallback(
    async (captureOptions?: AudioCaptureOptions) => {
      setError(null);

      // Stop existing track before creating new one. Capture the previous ref
      // synchronously so we can null it out before awaiting — otherwise the
      // unmount cleanup might also see and re-stop it.
      if (trackRef.current) {
        const previous = trackRef.current;
        trackRef.current = null;
        await previous.stop().catch(() => {
          // best-effort
        });
      }

      const mergedOptions = { ...optionsRef.current, ...captureOptions };
      const audioContext = getAudioContext();

      const trackOptions: AudioTrackOptions = {
        ...mergedOptions,
        audioContext,
      };

      const newTrack = new AudioTrack(trackOptions);

      // Critical (W1-5): assign trackRef.current BEFORE the async initialize()
      // call. If the component unmounts mid-getUserMedia, the cleanup effect
      // will see the in-flight track and stop it — preventing the leak where
      // initialize() resolves into a stopped/unmounted component holding a
      // live MediaStreamTrack.
      trackRef.current = newTrack;

      // Set up event listeners
      const handleMuted = () => setIsMuted(true);
      const handleUnmuted = () => setIsMuted(false);
      const handleEnded = () => {
        setIsCapturing(false);
        setState(newTrack.getState());
      };

      newTrack.on(TrackEvent.Muted, handleMuted);
      newTrack.on(TrackEvent.Unmuted, handleUnmuted);
      newTrack.on(TrackEvent.Ended, handleEnded);

      try {
        await newTrack.initialize(mergedOptions);
      } catch (err) {
        // initialize failed — clear the ref only if it still points at us.
        if (trackRef.current === newTrack) {
          trackRef.current = null;
        }
        const roomError = err as RoomError;
        setError(roomError);
        setIsCapturing(false);
        throw err;
      }

      // If the component unmounted while initialize() was in flight, the
      // cleanup effect will have stopped the track via trackRef.current
      // (which we set above). Detect that case and skip the React state
      // updates — they would target an unmounted component.
      if (trackRef.current !== newTrack) {
        // Track was stopped/cleared during initialize — nothing to publish.
        return;
      }

      setTrack(newTrack);
      setIsCapturing(true);
      setState(newTrack.getState());
      setIsMuted(newTrack.isMuted());
    },
    [getAudioContext],
  );

  // Stop capturing
  const stopCapture = useCallback(async () => {
    const currentTrack = trackRef.current;
    if (currentTrack) {
      await currentTrack.stop();
      trackRef.current = null;
      setTrack(null);
      setIsCapturing(false);
      setState(null);
    }
  }, []);

  // Mute
  const mute = useCallback(() => {
    trackRef.current?.mute();
  }, []);

  // Unmute
  const unmute = useCallback(() => {
    trackRef.current?.unmute();
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (trackRef.current?.isMuted()) {
      trackRef.current.unmute();
    } else {
      trackRef.current?.mute();
    }
  }, []);

  // Set feature
  const setFeature = useCallback(async (feature: AudioFeature, enabled: boolean) => {
    if (trackRef.current) {
      await trackRef.current.setFeature(feature, enabled);
    }
  }, []);

  // Restart
  const restart = useCallback(async (restartOptions?: AudioCaptureOptions) => {
    if (trackRef.current) {
      await trackRef.current.restart(restartOptions);
      setState(trackRef.current.getState());
    }
  }, []);

  // Auto-start if enabled
  useEffect(() => {
    if (options.autoStart) {
      startCapture().catch(() => {
        // Error is already captured in state
      });
    }
  }, [options.autoStart, startCapture]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Critical (W1-5): trackRef.current is now set BEFORE initialize()
      // resolves, so unmount-mid-init reliably reaches this branch and
      // stops the in-flight track.
      const inflightTrack = trackRef.current;
      if (inflightTrack) {
        trackRef.current = null;
        inflightTrack.stop().catch(() => {
          // Ignore errors on unmount
        });
      }
    };
  }, []);

  return {
    track,
    isCapturing,
    state,
    error,
    isMuted,
    startCapture,
    stopCapture,
    mute,
    unmute,
    toggleMute,
    setFeature,
    restart,
  };
}
